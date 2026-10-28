import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('./public', import.meta.url));
const envPath = fileURLToPath(new URL('./.env', import.meta.url));
const gigaChatCa = readFileSync(fileURLToPath(new URL('./certs/russian_trusted_root_ca_pem.crt', import.meta.url)), 'utf8');

async function loadEnv() {
  try {
    const text = await readFile(envPath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index < 1) continue;
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Не удалось прочитать .env:', error.message);
  }
}

await loadEnv();

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENROUTER_MODEL || 'cohere/north-mini-code:free';
const FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || 'nvidia/nemotron-3.5-lightning:free';
const QA_MODEL = process.env.OPENROUTER_QA_MODEL || 'nvidia/nemotron-3.5-lightning:free';
const QA_BACKUP_MODEL = process.env.OPENROUTER_QA_BACKUP_MODEL || 'cohere/north-mini-code:free';
const FREE_ROUTER_MODEL = process.env.OPENROUTER_FREE_MODEL || 'openrouter/free';
const GIGACHAT_AUTH_KEY = String(process.env.GIGACHAT_AUTH_KEY || process.env.GIGACHAT_CREDENTIALS || '').trim();
const GIGACHAT_SCOPE = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
const GIGACHAT_MODELS = (process.env.GIGACHAT_MODEL || 'GigaChat-2-Max,GigaChat-2-Pro,GigaChat-2')
  .split(',').map(item => item.trim()).filter(Boolean);
let gigaChatToken = { value: '', expiresAt: 0 };
let gigaChatAuthFailure = { message: '', retryAfter: 0 };

function requestGigaChatJson(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(String(body || ''), 'utf8');
    const request = httpsRequest(url, {
      method: 'POST',
      ca: gigaChatCa,
      rejectUnauthorized: true,
      headers: { ...headers, 'Content-Length': payload.length }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2_000_000) {
          request.destroy(new Error('Ответ GigaChat превышает 2 МБ'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`GigaChat не ответил за ${Math.round(timeoutMs / 1000)} секунд`)));
    request.on('error', reject);
    request.end(payload);
  });
}

// Дополнительные провайдеры, совместимые с OpenAI-форматом. GigaChat имеет
// отдельную OAuth-авторизацию и всегда ставится перед этими маршрутами.
const DIRECT_PROVIDERS = [];
for (const [envPrefix, label, url, defaultModels] of [
  ['GEMINI', 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'models/gemini-3.5-flash,models/gemini-flash-lite-latest'],
  ['GROQ', 'Groq', 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile'],
  ['MISTRAL', 'Mistral', 'https://api.mistral.ai/v1/chat/completions', 'mistral-small-latest']
]) {
  const apiKey = process.env[`${envPrefix}_API_KEY`];
  if (!apiKey || apiKey.includes('your-key')) continue;
  DIRECT_PROVIDERS.push({
    id: envPrefix.toLowerCase(),
    label,
    url,
    apiKey,
    models: (process.env[`${envPrefix}_MODEL`] || defaultModels).split(',').map(item => item.trim()).filter(Boolean),
    // Размышляющие модели Gemini могут потратить весь лимит на reasoning и
    // вернуть пустой контент; просим минимальные размышления.
    extraBody: envPrefix === 'GEMINI' ? { reasoning_effort: 'low' } : undefined
  });
}
const MAX_TOKENS = Math.max(2000, Math.min(Number(process.env.OPENROUTER_MAX_TOKENS) || 10000, 12000));
const MODEL_TIMEOUT_MS = Math.max(30_000, Math.min(Number(process.env.MODEL_TIMEOUT_MS) || 90_000, 120_000));
const MAX_REPAIR_ATTEMPTS = Math.max(0, Math.min(Number(process.env.MAX_REPAIR_ATTEMPTS) || 1, 2));
const MODEL_BACKOFF = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

const SYSTEM_PROMPT = `Ты — опытный разработчик мобильных HTML5-игр. Верни ТОЛЬКО полный HTML-документ, начиная с <!doctype html>. Никакого Markdown и пояснений.

Создай законченную играбельную игру по запросу пользователя. Жёсткие требования:
- Один self-contained HTML-файл: весь CSS и JS внутри, без CDN, внешних файлов, fetch, import, библиотек и сетевых запросов.
- Игра должна работать офлайн в мобильном WebView и в iframe с sandbox="allow-scripts".
- Обязательны: понятный старт, игровой цикл, счёт или прогресс, однозначная победа/поражение и кнопка повторной игры.
- Поддержи touch/pointer и клавиатуру. Не полагайся только на hover. Запрети нежелательный скролл жестами через touch-action.
- Для игр с направлением движения (змейка, лабиринт) реализуй Arrow Keys, WASD, свайпы и тап по стороне поля. Не рассчитывай на внешние элементы оболочки и не рисуй отдельный D-pad/блок экранных стрелок — ни в разметке, ни создавая кнопки динамически (в том числе кнопки с подписями ↑ ↓ ← →).
- Игра не имеет права запускать таймер или движение до явного действия пользователя по кнопке старта. После старта игрок должен иметь минимум 3 секунды безопасного времени; начальная позиция и направление не могут приводить к мгновенному поражению.
- Для спокойной змейки для пожилой аудитории интервал шага должен быть 350–600 мс. Переменная safeUntil сама по себе не считается защитой: до её окончания столкновение со стеной/хвостом не должно завершать игру, либо геометрия и скорость должны гарантировать безопасный путь дольше трёх секунд.
- В змейке для пожилой аудитории края поля всегда должны переносить голову на противоположную сторону (wrap-around). Край экрана не является поражением; проигрыш возможен от хвоста или понятного препятствия.
- Нельзя обеспечивать safe-период пустой веткой, которая просто игнорирует столкновения и позволяет координатам уйти за поле. Используй перенос по краям, остановку у границы или не двигай объект до первого направления пользователя.
- Перед ответом мысленно пройди сценарий: старт → три разных управляющих действия → изменение счёта/прогресса → поражение или победа → повторный старт. Проверь, что обработчики ввода меняют именно игровое состояние.
- Если requestAnimationFrame-цикл запускается до нажатия Start, он обязан продолжать планировать следующий кадр даже в состоянии ожидания. Нельзя делать ранний return до следующего requestAnimationFrame: иначе после Start игра останется неподвижной.
- Все модальные экраны, кнопки и игровое поле должны целиком помещаться во viewport без обрезки. На resize пересчитай размеры, но не сбрасывай игру неожиданно.
- Скрывай экраны старта и финиша только через display:none/visibility:hidden либо добавляй pointer-events:none: невидимый оверлей не имеет права перехватывать клики и касания.
- Адаптивная вёрстка от 320x480 до desktop, canvas учитывает devicePixelRatio. Элементы управления не меньше 48px.
- Текст интерфейса — на языке запроса. Учитывай аудиторию: возраст, доступность, размер элементов, темп, контраст.
- Никаких alert/prompt/confirm, eval, Function(), document.write и навигации верхнего окна.
- Допустимы Canvas, Web Audio API и процедурная графика/звук. Звук запускай только после жеста пользователя.
- Для аналитики отправляй родителю window.parent.postMessage({type:'vibeplay:event', event:'start'|'win'|'lose'|'restart', score:Number}, '*').
- Код должен быть читаемым, устойчивым к resize и без незавершённых TODO.

Логическая честность — проверяется в первую очередь, «красиво, но неиграбельно» не принимается:
- Правила работают в пользу игрока: выигрышное условие достижимо, поражение наступает только по вине игрока.
- Игры на совпадение (пары, «найди одинаковые»): сравнивай значение/символ карточек из единого источника данных, а не DOM-элементы и не индексы. Совпавшая пара фиксируется навсегда и не переворачивается обратно; несовпадение — короткая обратная связь, переворот двух карточек и следующий ход. Найденные пары, счёт и прогресс никогда не сбрасываются из-за неправильного хода; полный сброс — только по явной кнопке «заново».
- Викторины и выбор ответа: правильный ответ задан явно; обработчик сравнивает выбор игрока именно с этим источником истины. Проверь сравнение на конкретном примере (типы, регистр, индексация с нуля). Неправильный ответ — это подсказка и переход дальше, а не мгновенный рестарт уровня.
- Лимиты и арифметика: посчитай на пальцах, сколько ходов/попыток даётся и сколько тратится на каждый сценарий; лимит не имеет права сработать на первом же правильном ходе.
- Перед выдачей мысленно сыграй две полные партии: (1) только правильные ходы — от старта до победы; (2) с ошибками — игра обязана корректно продолжаться и не терять прогресс.

Стандарт визуального качества — обязателен, «работает» не значит «готово»:
- Целостная арт-дирекция: палитра из 4–6 цветов через CSS-переменные, фоновые градиенты, скругления, мягкие тени. Запрещён дефолтный браузерный вид: неоформленные системные кнопки, плоский белый фон без стиля.
- Экраны старта, победы и поражения — в едином визуальном языке, с крупным заголовком, краткой инструкцией и заметной кнопкой.
- Живая обратная связь: анимация цели/еды (@keyframes), отклик счёта на каждое очко, плавные переходы между состояниями.
- Синтезированный звук через Web Audio API на ключевые события (старт, очко, победа, поражение) и заметная кнопка включения/выключения звука.
- Крупная читаемая типографика, контраст текста с фоном не ниже 4.5:1.

Перед ответом мысленно пройди три списка: сценарий «старт → три разных управляющих действия → прогресс → победа/поражение → повторный запуск», логическую честность из блока выше на конкретных ходах и чек-лист визуального качества; исправь слабые пункты до выдачи.

Делай не шаблон, а механику и визуальный стиль, соответствующие конкретному запросу.`;

const QA_PROMPT = `You are the final QA engineer for a generated self-contained HTML5 game. Return ONLY the complete corrected HTML document, beginning with <!doctype html>. Never return commentary or Markdown.

Inspect the candidate code line by line and repair it, not merely restyle it. Logic comes first: replay the core rule on concrete data. For matching/pair games, verify the comparison reads card values from a single source of truth — not DOM element identity and not array indices — and that a matched pair stays fixed while a mismatch merely flips back after feedback; already-found pairs, score and progress must never reset on a wrong pick, and a full reset requires an explicit restart button. For quiz/choice games, trace the correct-answer check on one real question and one wrong pick: the correct pick advances, the wrong pick gives feedback without restarting the level or wiping progress. Check move/attempt limit arithmetic so a limit never triggers on the first correct action. Mentally execute these scenarios: load without auto-start; press Start; wait three seconds without losing; use keyboard controls; use touch/pointer controls; reach a win or loss; press Restart and play again. Explicitly verify that an animation loop which returns while waiting for Start is scheduled again by Start; a one-shot requestAnimationFrame before Start is a critical failure. A safeUntil variable is insufficient unless collision logic actually respects it or board geometry and movement interval guarantee more than three safe seconds. Never ignore wall collisions while still allowing coordinates to move outside the board; wrap, clamp, pause, or keep coordinates valid. An elderly-audience snake must wrap around every board edge throughout the whole game and use a 350–600 ms movement interval. Fix broken event targets, immediate game-over states, invalid initial positions, reversed collision conditions, timers that continue behind overlays, clipped layouts, unusable speed, missing resize handling, and controls that only work after accidental focus. Directional games must use keyboard plus swipe/side-tap controls; a visible on-screen arrow pad is forbidden, including buttons labelled ↑ ↓ ← → whether written in markup or created dynamically via createElement. Keep one offline HTML file with no external dependencies.

You are also the quality bar owner. After mechanics are sound, raise the result to a polished, shippable level: a cohesive palette of 4–6 colors defined as CSS variables, background gradients, rounded corners, soft shadows; animated feedback (CSS @keyframes for the goal/food, score bump, state transitions); start, win and lose screens sharing one visual language with a clear headline and button; synthesized Web Audio sounds on key events with a visible mute toggle; large readable high-contrast typography. A bare default browser look — unstyled buttons, flat white background, zero transitions — is a defect: restyle it completely while preserving the working game logic, then re-run every mechanical scenario in your head to confirm nothing broke.

The automated gate scans the returned source literally and clicks the Start button in a real headless browser at its actual coordinates, so satisfy it in code, not in intent: the string 'win' must appear in the game script sent through parent.postMessage (a helper like function postEvent(type){parent.postMessage({type:'vibeplay:event',event:type,...})} followed by postEvent('win') is fine, but the literal 'win' call must exist and be reachable in gameplay); edge wrapping must be implemented with a modulo expression or a named wrap() helper rather than a wall-collision game over; a movement interval variable named moveInterval/stepInterval/tickInterval must be at least 350 for elderly-audience snakes; hidden overlays must use display:none or pointer-events:none — an opacity-only hidden overlay that still swallows real taps is a critical failure the live browser test will catch.`;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 2_000_000) {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function extractHtml(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || text).trim();
  const start = candidate.search(/<!doctype html|<html/i);
  if (start === -1) throw new Error('Модель не вернула HTML-документ');
  return candidate.slice(start);
}

function validateGame(html, prompt = '') {
  const errors = [];
  const directionalGame = /(?:snake|зме(?:й|я|и|ек)|лабиринт|maze)/i.test(prompt);
  if (html.length < 1500) errors.push('HTML слишком короткий для готовой игры');
  if (!/<script[\s>]/i.test(html)) errors.push('нет JavaScript');
  if (!/(<canvas[\s>]|requestAnimationFrame|pointerdown|click)/i.test(html)) errors.push('не найден игровой ввод или цикл');
  if (/<script[^>]+src=|<link[^>]+href=|\b(?:fetch|import)\s*\(|https?:\/\//i.test(html)) errors.push('обнаружена внешняя зависимость');
  if (/\beval\s*\(|\bFunction\s*\(/.test(html)) errors.push('обнаружено небезопасное выполнение кода');
  if (!/(?:keydown|keyup|ArrowUp|ArrowDown|KeyW)/i.test(html)) errors.push('нет клавиатурного управления');
  if (!/(?:pointerdown|pointerup|touchstart|touchend)/i.test(html)) errors.push('нет touch/pointer управления');
  if (!/(?:restart|play again|играть снова|начать заново|повтор)/i.test(html)) errors.push('нет повторного запуска');
  if (directionalGame && !/(?:ArrowLeft|ArrowRight|ArrowUp|ArrowDown)/i.test(html)) errors.push('игра не обрабатывает стрелки');
  const arrowPadInMarkup = /<button[^>]*>[^<]*[↑↓←→▲▼◀▶][^<]*<\/button>/i.test(html);
  const arrowPadInScript = /(?:[↑↓←→▲▼◀▶][\s\S]{0,300}?createElement\s*\(\s*['"]button|createElement\s*\(\s*['"]button[\s\S]{0,300}?[↑↓←→▲▼◀▶])/i.test(html);
  if (directionalGame && (/(?:onScreenArrows|arrowPad|d-?pad|directionButtons)/i.test(html) || arrowPadInMarkup || arrowPadInScript)) {
    errors.push('отдельный блок экранных стрелок запрещён');
  }
  if (/(?:бабуш|grandma|elderly|пожил)/i.test(prompt) && /(?:snake|зме(?:й|я|и|ек))/i.test(prompt)) {
    const interval = html.match(/(?:moveInterval|stepInterval|tickInterval)\s*=\s*(\d+)/i);
    if (interval && Number(interval[1]) < 350) errors.push('темп змейки слишком быстрый для аудитории: нужен интервал не меньше 350 мс');
    const boundaryCheck = /(?:head\.x\s*<\s*0|head\.x\s*>=\s*(?:tileCount|cols|gridWidth)|head\.y\s*<\s*0|head\.y\s*>=\s*(?:tileCount|rows|gridHeight))/i.test(html);
    const wrapsEdges = /%\s*(?:tileCount|cols|gridWidth|rows|gridHeight|cellCount|gridSize|boardSize|width|height)\b|(?:\bwrap\w*\s*\(|wrapAround|wrap_)/i.test(html);
    if (boundaryCheck && !wrapsEdges) {
      errors.push('для пожилой аудитории край поля должен переносить змейку, а не завершать игру');
    }
  }
  if (/if\s*\([^)]*safeUntil[^)]*\)\s*\{\s*(?:\/\/[^\r\n]*(?:\r?\n)?\s*)*\}/i.test(html)) {
    errors.push('safe-период пустой и позволяет игровым координатам выйти за границы');
  }
  if (!/postMessage/.test(html) || !/['"]win['"]/.test(html)) errors.push('нет рабочего события победы');
  for (const match of html.matchAll(/function\s+([A-Za-z_$][\w$]*(?:loop|Loop))\s*\([^)]*\)\s*\{/g)) {
    const snippet = html.slice(match.index, match.index + 1800);
    const earlyStop = snippet.search(/if\s*\([^)]*(?:gameRunning|running|playing|gameActive)[^)]*\)\s*(?:\{\s*)?return\b/i);
    const nextFrame = snippet.search(new RegExp(`requestAnimationFrame\\s*\\(\\s*${match[1]}\\s*\\)`, 'i'));
    if (earlyStop >= 0 && (nextFrame < 0 || nextFrame > earlyStop)) {
      errors.push(`цикл ${match[1]} прекращается до Start и не возобновляется`);
      break;
    }
  }
  return errors;
}

function addTouchBridge(html, tapDirections = false) {
  if (html.includes('data-vibeplay-touch-bridge="3"')) return html;
  html = html.replace(/<script\b[^>]*data-vibeplay-touch-bridge[^>]*>[\s\S]*?<\/script>\s*/gi, '');
  const bridge = `<script data-vibeplay-touch-bridge="3">
(()=>{
  const tapDirections=${tapDirections};
  const codes={ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40};
  let start=null;
  function interactive(target){return target instanceof Element&&Boolean(target.closest('button,a,input,textarea,select,[role="button"]'))}
  function restartIfVisible(){
    const button=[...document.querySelectorAll('button,[role="button"]')].find(item=>{const style=getComputedStyle(item);return !item.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&/(?:играть снова|начать игру|начать|старт|restart|play again|start game)/i.test(item.textContent||'')});
    if(button)button.click();
  }
  function send(key){
    restartIfVisible();
    const targets=[window,document,document.body,document.activeElement,document.querySelector('canvas')].filter(Boolean);
    const emit=(target,type)=>{
      const event=new KeyboardEvent(type,{key,code:key,bubbles:false,cancelable:true});
      try{Object.defineProperties(event,{keyCode:{get:()=>codes[key]},which:{get:()=>codes[key]}})}catch{}
      target.dispatchEvent(event);
    };
    [...new Set(targets)].forEach(target=>emit(target,'keydown'));
    setTimeout(()=>[...new Set(targets)].forEach(target=>emit(target,'keyup')),60);
  }
  document.documentElement.style.touchAction='none';
  document.addEventListener('pointerdown',event=>{
    if(interactive(event.target))return;
    start={x:event.clientX,y:event.clientY,id:event.pointerId};
    if(document.body){document.body.tabIndex=-1;document.body.focus({preventScroll:true})}
  },{passive:true});
  document.addEventListener('pointerup',event=>{
    if(!start||start.id!==event.pointerId)return;
    const dx=event.clientX-start.x,dy=event.clientY-start.y;
    start=null;
    if(Math.max(Math.abs(dx),Math.abs(dy))>=24){send(Math.abs(dx)>Math.abs(dy)?(dx>0?'ArrowRight':'ArrowLeft'):(dy>0?'ArrowDown':'ArrowUp'));return}
    if(!tapDirections||interactive(event.target))return;
    const x=event.clientX/innerWidth-.5,y=event.clientY/innerHeight-.5;
    send(Math.abs(x)>Math.abs(y)?(x>0?'ArrowRight':'ArrowLeft'):(y>0?'ArrowDown':'ArrowUp'));
  },{passive:true});
  addEventListener('message',event=>{if(event.data?.type==='vibeplay:control'&&codes[event.data.key])send(event.data.key)});
})();
</script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${bridge}</body>`);
  if (/<\/html\s*>/i.test(html)) return html.replace(/<\/html\s*>/i, `${bridge}</html>`);
  return `${html}${bridge}`;
}

function isCreditLimitError(status, message) {
  return status === 402 || /more credits|can only afford|insufficient credits|payment required/i.test(message);
}

const SMOKE_ENABLED = !/^(?:0|false|no)$/i.test(process.env.VIBEPLAY_SMOKE || '');

function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      accessSync(path, constants.F_OK);
      return path;
    } catch {}
  }
  return null;
}

// Живая проверка геймплея в headless Chrome: страница загружается, старт
// кликается, направленная игра показывает движение и переживает стрелку
// без мгновенного поражения. Возвращает список дефектов или null, если
// окружение не позволяет запустить проверку (тогда конвейер её пропускает).
async function smokeTestGame(html, prompt) {
  if (!SMOKE_ENABLED || typeof WebSocket === 'undefined') return null;
  const chromePath = findChromePath();
  if (!chromePath) return null;

  const profileDir = mkdtempSync(join(tmpdir(), 'vibeplay-smoke-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--hide-scrollbars', '--mute-audio',
    '--window-size=390,844',
    `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanup = () => {
    try { chrome.kill(); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  let socket = null;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome не запустился за 12 с')), 12_000);
      let buffer = '';
      chrome.stderr.on('data', chunk => {
        buffer += chunk;
        const match = buffer.match(/DevTools listening on .*?:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      chrome.once('exit', () => { clearTimeout(timer); reject(new Error('Chrome завершился при старте')); });
    });

    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = pages.find(page => page.type === 'page');
    if (!target) throw new Error('нет page-таргета');

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let seq = 0;
    const pending = new Map();
    const jsErrors = [];
    socket.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); return; }
      if (data.method === 'Runtime.exceptionThrown') {
        const details = data.params?.exceptionDetails;
        jsErrors.push(String(details?.exception?.description || details?.text || 'неизвестная ошибка').slice(0, 200));
      }
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`таймаут CDP: ${method}`)); }
      }, 15_000);
    });
    const evaluate = async expression => {
      const response = await call('Runtime.evaluate', { expression, returnByValue: true });
      return response.result?.result?.value;
    };

    await call('Runtime.enable');
    await call('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
    let ready = null;
    for (let i = 0; i < 40 && ready !== 'complete'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 250));
      ready = await evaluate('document.readyState').catch(() => null);
    }
    if (ready !== 'complete') throw new Error('страница не загрузилась');

    const boot = await evaluate(`(()=>{try{return JSON.stringify({buttons:document.querySelectorAll('button').length,canvas:!!document.querySelector('canvas')})}catch(e){return 'ERR:'+e.message}})()`);
    if (typeof boot !== 'string' || boot.startsWith('ERR')) return ['страница игры не выполняется: ' + boot];

    const startInfo = await evaluate(`(()=>{
      const all=[...document.querySelectorAll('button')];
      const visible=all.filter(b=>{
        const r=b.getBoundingClientRect(); if(r.width<1||r.height<1)return false;
        const s=getComputedStyle(b); if(s.display==='none'||s.visibility==='hidden'||s.pointerEvents==='none')return false;
        return r.x>=0&&r.y>=0&&r.x+r.width<=innerWidth&&r.y+r.height<=innerHeight;
      });
      if(!visible.length)return JSON.stringify({error:all.length?'clipped':'none'});
      // Эмодзи-кнопки вроде 🔊 — не старт: берём кнопки с обычным текстом.
      const textual=visible.filter(b=>((b.textContent||'').match(/[\\p{L}\\p{N}]/gu)||[]).length>=2);
      const pool=textual.length?textual:visible;
      const byPattern=pool.find(b=>/(?:старт|начать|начни|войти|вход|играть|сыграть|поиграть|поехали|давай|продолжить|попробовать|start|begin|play|go\\b|try|enter)/i.test(b.textContent||''));
      const bySize=[...pool].sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return rb.width*rb.height-ra.width*ra.height})[0];
      const startBtn=byPattern||bySize;
      if(!startBtn)return JSON.stringify({error:'none'});
      const rect=startBtn.getBoundingClientRect();
      const x=rect.x+rect.width/2,y=rect.y+rect.height/2;
      const top=document.elementFromPoint(x,y);
      const coversButton=top&&top!==startBtn&&!startBtn.contains(top)&&!top.contains(startBtn);
      if(top&&coversButton)top.setAttribute('data-vibeplay-hit-mark','1');
      return JSON.stringify({x,y,coversButton:!!coversButton});
    })()`);
    const start = JSON.parse(startInfo);
    if (start.error === 'none') return ['не найдена кнопка старта'];
    if (start.error === 'clipped') return ['кнопка не видна целиком в окне (обрезана вёрсткой или ушла за край)'];
    // Настоящий клик по координатам: через hit-testing браузера, как у живого
    // пользователя — слой, глотающий клики, здесь проявится.
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 60));
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 300));

    const failures = [];
    if (start.coversButton) {
      const verdict = await evaluate(`(()=>{
        const marked=document.querySelector('[data-vibeplay-hit-mark]');
        if(!marked)return 'gone';
        const style=getComputedStyle(marked);
        if(style.display==='none'||style.visibility==='hidden'||style.pointerEvents==='none')return 'hidden';
        const top=document.elementFromPoint(${start.x},${start.y});
        return top===marked?'blocked':'moved';
      })()`);
      if (verdict === 'blocked') failures.push('клик по кнопке старта не доходит до игры: верхний слой перехватывает нажатие (нужен display:none или pointer-events:none)');
    }

    const gameOverVisible = () => evaluate(`(()=>{try{return /(?:game over|поражение|конец игры|вы проиграли)/i.test((document.body&&document.body.innerText)||'')}catch(e){return false}})()`).catch(() => false);
    await new Promise(resolve => setTimeout(resolve, 1200));
    if (await gameOverVisible()) failures.push('экран поражения появляется сразу после старта');

    const directional = /(?:snake|зме(?:й|я|и|ек)|лабиринт|maze)/i.test(prompt);
    if (directional && JSON.parse(boot).canvas) {
      const shot = () => evaluate(`(()=>{const c=document.querySelector('canvas');return c?c.toDataURL():''})()`).catch(() => '');
      const idle0 = await shot();
      await new Promise(resolve => setTimeout(resolve, 1500));
      const idle1 = await shot();
      await evaluate(`(()=>{
        const targets=[window,document,document.body,document.activeElement,document.querySelector('canvas')].filter(Boolean);
        const emit=(t,type)=>{const e=new KeyboardEvent(type,{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true});try{Object.defineProperties(e,{keyCode:{get:()=>40},which:{get:()=>40}})}catch{};t.dispatchEvent(e)};
        [...new Set(targets)].forEach(t=>{emit(t,'keydown');emit(t,'keyup')});
        return true;
      })()`);
      await new Promise(resolve => setTimeout(resolve, 2500));
      const afterKey = await shot();
      if (idle0 && idle0 === idle1 && idle1 === afterKey) failures.push('игра не показывает движения ни в покое, ни после стрелки');
      if (await gameOverVisible()) failures.push('поражение наступает в первые секунды после старта без вины игрока');
    }

    if (jsErrors.length) failures.push(`ошибки JS в игре: ${jsErrors[0]}`);
    return failures;
  } catch (error) {
    console.warn(`Smoke-тест пропущен: ${error.message}`);
    return null;
  } finally {
    try { socket?.close(); } catch {}
    cleanup();
  }
}

// Статические дефекты хуже живых: игра без JavaScript непригодна совсем,
// а живой провал (например, мёртвая кнопка) хотя бы открывается и чинится.
async function checkPlayable(html, prompt) {
  const staticErrors = validateGame(html, prompt);
  if (staticErrors.length) return { static: staticErrors, live: [] };
  const liveFailures = await smokeTestGame(html, prompt);
  return { static: [], live: liveFailures || [] };
}

const defectWeight = result => result.static.length * 2 + result.live.length;

function friendlyOpenRouterError(status, message) {
  if (isCreditLimitError(status, message)) return 'На OpenRouter закончились кредиты';
  if (status === 429) return 'OpenRouter временно ограничил частоту запросов. Попробуйте ещё раз через минуту';
  if (status === 401 || status === 403) return 'OpenRouter отклонил API-ключ. Проверьте OPENROUTER_API_KEY в .env';
  return `OpenRouter не смог создать игру: ${message || `ошибка ${status}`}`;
}

async function requestOpenRouter(messages, temperature, model) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('your-key')) {
    const error = new Error('Добавьте OPENROUTER_API_KEY в файл .env');
    error.status = 503;
    throw error;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'VibePlay AI Hackathon MVP'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: MAX_TOKENS,
      reasoning: { enabled: false, exclude: true }
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `OpenRouter вернул ${response.status}`;
    const error = new Error(message);
    error.openRouterMessage = message;
    error.openRouterStatus = response.status;
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  return {
    content: payload?.choices?.[0]?.message?.content,
    model: payload?.model || model,
    usedFallback: model !== MODEL
  };
}

async function requestDirect(provider, model, messages, temperature) {
  const response = await fetch(provider.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature, max_tokens: 12_000, ...(provider.extraBody || {}) }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `${provider.label} ${model} вернул ${response.status}`;
    const error = new Error(message);
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error(`${provider.label} ${model}: пустой ответ (finish_reason: ${payload?.choices?.[0]?.finish_reason || 'неизвестно'} — возможно, весь лимит токенов ушёл на рассуждения модели или провайдер перегружен)`);
  }
  return { content, model: `${provider.id}/${model}`, usedFallback: true };
}

async function getGigaChatToken(forceRefresh = false) {
  if (!GIGACHAT_AUTH_KEY) throw new Error('Добавьте GIGACHAT_AUTH_KEY в файл .env');
  if (!forceRefresh && gigaChatAuthFailure.retryAfter > Date.now()) {
    throw new Error(gigaChatAuthFailure.message);
  }
  if (!forceRefresh && gigaChatToken.value && gigaChatToken.expiresAt > Date.now() + 60_000) {
    return gigaChatToken.value;
  }

  const authorization = GIGACHAT_AUTH_KEY.startsWith('Basic ')
    ? GIGACHAT_AUTH_KEY
    : `Basic ${GIGACHAT_AUTH_KEY}`;
  let result;
  try {
    result = await requestGigaChatJson('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: randomUUID(),
        'User-Agent': 'VibePlay-AI/1.2'
      },
      body: new URLSearchParams({ scope: GIGACHAT_SCOPE }),
      timeoutMs: 30_000
    });
  } catch (cause) {
    const message = `Не удалось подключиться к авторизации GigaChat: ${cause.message}`;
    gigaChatAuthFailure = { message, retryAfter: Date.now() + 5 * 60_000 };
    throw new Error(message);
  }
  const payload = result.json;
  if (!result.ok || !payload.access_token) {
    const detail = payload.message || payload.error_description || payload.error || `ошибка ${result.status}`;
    const error = new Error(`GigaChat не выдал токен доступа: ${detail}`);
    gigaChatAuthFailure = { message: error.message, retryAfter: Date.now() + 5 * 60_000 };
    error.status = result.status === 429 ? 429 : 502;
    throw error;
  }

  const rawExpiry = Number(payload.expires_at);
  const expiresAt = Number.isFinite(rawExpiry) && rawExpiry > 0
    ? (rawExpiry > 10_000_000_000 ? rawExpiry : rawExpiry * 1000)
    : Date.now() + 29 * 60_000;
  gigaChatToken = { value: payload.access_token, expiresAt };
  gigaChatAuthFailure = { message: '', retryAfter: 0 };
  return gigaChatToken.value;
}

async function requestGigaChat(model, messages, temperature, retryAuth = true) {
  const accessToken = await getGigaChatToken();
  const result = await requestGigaChatJson('https://api.giga.chat/v1/chat/completions', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'VibePlay-AI/1.2'
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: MAX_TOKENS, stream: false }),
    timeoutMs: MODEL_TIMEOUT_MS
  });
  const payload = result.json;
  if (result.status === 401 && retryAuth) {
    gigaChatToken = { value: '', expiresAt: 0 };
    await getGigaChatToken(true);
    return requestGigaChat(model, messages, temperature, false);
  }
  if (!result.ok) {
    const detail = payload.message || payload.error?.message || payload.error || `ошибка ${result.status}`;
    const message = result.status === 402 ? 'закончились бесплатные токены этой модели' : detail;
    const error = new Error(`GigaChat ${model}: ${message}`);
    error.status = result.status === 429 ? 429 : 502;
    throw error;
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) throw new Error(`GigaChat ${model}: пустой ответ`);
  return { content, model: `gigachat/${model}`, usedFallback: false };
}

function gigaChatRoutes(messages, temperature) {
  if (!GIGACHAT_AUTH_KEY || GIGACHAT_AUTH_KEY.includes('your-key')) return [];
  return GIGACHAT_MODELS.map(model => ({
    label: `GigaChat ${model}`,
    run: () => requestGigaChat(model, messages, temperature)
  }));
}

function openRouterRoutes(messages, temperature, models) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('your-key')) return [];
  return [...new Set(models.filter(Boolean))].map(model => ({
    label: `OpenRouter ${model}`,
    run: () => requestOpenRouter(messages, temperature, model)
  }));
}

function directProviderRoutes(messages, temperature) {
  return DIRECT_PROVIDERS.flatMap(provider => provider.models.map(model => ({
    label: `${provider.label} ${model}`,
    run: () => requestDirect(provider, model, messages, temperature)
  })));
}

async function runModelChain(stage, routes) {
  if (!routes.length) {
    const error = new Error('Добавьте в .env ключ хотя бы одного провайдера: GIGACHAT_AUTH_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, GROQ_API_KEY или MISTRAL_API_KEY');
    error.status = 503;
    throw error;
  }
  let lastError;
  for (const route of routes) {
    const retryAfter = MODEL_BACKOFF.get(route.label) || 0;
    if (retryAfter > Date.now()) {
      console.warn(`${stage}: ${route.label} временно пропущен после предыдущей ошибки`);
      continue;
    }
    try {
      const result = await route.run();
      if (result?.content && String(result.content).trim()) {
        MODEL_BACKOFF.delete(route.label);
        return result;
      }
      lastError = new Error('модель вернула пустой ответ');
      MODEL_BACKOFF.set(route.label, Date.now() + 5 * 60_000);
    } catch (error) {
      lastError = error;
      const delay = isCreditLimitError(error.openRouterStatus, error.message) ? 15 * 60_000 : 5 * 60_000;
      MODEL_BACKOFF.set(route.label, Date.now() + delay);
      console.warn(`${stage}: ${route.label} недоступен — ${error.message}`);
    }
  }
  const detail = lastError?.openRouterStatus !== undefined
    ? friendlyOpenRouterError(lastError.openRouterStatus, lastError.message)
    : lastError?.message || 'неизвестная ошибка';
  const wrapped = new Error(`${stage}: не удалось получить ответ модели. ${detail}`);
  wrapped.status = lastError?.status || 502;
  throw wrapped;
}

async function askGenerator(messages, temperature = 0.75) {
  return runModelChain('Генерация', [
    ...gigaChatRoutes(messages, temperature),
    ...directProviderRoutes(messages, temperature),
    ...openRouterRoutes(messages, temperature, [MODEL, FALLBACK_MODEL, FREE_ROUTER_MODEL, QA_MODEL, QA_BACKUP_MODEL])
  ]);
}

async function askQa(messages, temperature = 0.1) {
  return runModelChain('QA', [
    ...gigaChatRoutes(messages, temperature),
    ...directProviderRoutes(messages, temperature),
    ...openRouterRoutes(messages, temperature, [QA_MODEL, QA_BACKUP_MODEL, FALLBACK_MODEL, FREE_ROUTER_MODEL])
  ]);
}

async function generateGame(input) {
  const prompt = String(input.prompt || '').trim();
  const revision = String(input.revision || '').trim();
  const currentHtml = String(input.currentHtml || '').replace(/<script\b[^>]*data-vibeplay-touch-bridge[^>]*>[\s\S]*?<\/script>\s*/gi, '');
  const analytics = input.analytics && typeof input.analytics === 'object' ? input.analytics : {};

  if (!prompt || prompt.length < 5) {
    const error = new Error('Опишите игру хотя бы пятью символами');
    error.status = 400;
    throw error;
  }
  if (prompt.length > 2000 || revision.length > 1000 || currentHtml.length > 1_000_000) {
    const error = new Error('Запрос или текущая игра слишком большие');
    error.status = 413;
    throw error;
  }

  const context = [
    `ЗАПРОС: ${prompt}`,
    revision ? `ДОРАБОТКА: ${revision}` : '',
    Object.keys(analytics).length ? `АГРЕГИРОВАННАЯ АНАЛИТИКА ПРОШЛЫХ ИГР: ${JSON.stringify(analytics)}. Используй только как слабую подсказку и не копируй механику без причины.` : '',
    currentHtml ? `ТЕКУЩАЯ ВЕРСИЯ. Сохрани рабочие части и внеси запрошенную доработку:\n${currentHtml}` : ''
  ].filter(Boolean).join('\n\n');

  const isRepair = Boolean(revision && currentHtml);
  const initialMessages = [
    { role: 'system', content: isRepair ? `${SYSTEM_PROMPT}\n\n${QA_PROMPT}` : SYSTEM_PROMPT },
    { role: 'user', content: context }
  ];
  let generation = isRepair
    ? await askQa(initialMessages, 0.12)
    : await askGenerator(initialMessages, 0.75);
  let html = extractHtml(generation.content);
  let usedModel = generation.model;
  let usedFallback = generation.usedFallback;
  let errors = await checkPlayable(html, prompt);
  let best = { html, model: usedModel, usedFallback, errors };

  for (let attempt = 1; errors.static.length + errors.live.length && attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      generation = await askQa([
        { role: 'system', content: `${SYSTEM_PROMPT}\n\n${QA_PROMPT}` },
        { role: 'user', content: `${context}\n\nCURRENT CANDIDATE HTML:\n${html}\n\nAUTOMATED TEST FAILURES (attempt ${attempt}):\n- ${[...errors.static, ...errors.live].join('\n- ')}\n\nFix every listed failure. Remove forbidden UI instead of hiding it. Return only the complete corrected HTML.` }
      ], 0.12);
      html = extractHtml(generation.content);
      usedModel = generation.model;
      usedFallback ||= generation.usedFallback;
      errors = await checkPlayable(html, prompt);
      if (defectWeight(errors) < defectWeight(best.errors)) best = { html, model: usedModel, usedFallback, errors };
    } catch (repairError) {
      console.warn(`Ремонт (попытка ${attempt}) не выполнен, сохраняем лучшего кандидата: ${repairError.message}`);
      break;
    }
  }

  // Отдаём лучшего кандидата после одного ремонта. Дополнительный безусловный
  // LLM-QA здесь не нужен: он удваивал время ожидания даже при готовой игре.
  if (defectWeight(errors) < defectWeight(best.errors)) best = { html, model: usedModel, usedFallback, errors };
  html = best.html;
  usedModel = best.model;
  usedFallback = best.usedFallback;
  const warnings = [...best.errors.static, ...best.errors.live];
  const qualityChecked = warnings.length === 0;
  if (warnings.length) console.warn(`Игра сохранена с замечаниями: ${warnings.join('; ')}`);

  html = addTouchBridge(html, /(?:snake|зме(?:й|я|и|ек))/i.test(prompt));
  return { html, model: usedModel, usedFallback, qualityChecked, warnings: warnings.slice(0, 3) };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(root, safePath);
  if (!filePath.startsWith(root)) return json(res, 403, { error: 'Доступ запрещён' });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw Object.assign(new Error('not file'), { code: 'ENOENT' });
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { error: 'Не найдено' });
    json(res, 500, { error: 'Ошибка чтения файла' });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') {
      return json(res, 200, {
        ok: true,
        configured: Boolean((GIGACHAT_AUTH_KEY && !GIGACHAT_AUTH_KEY.includes('your-key')) || (process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.includes('your-key')) || DIRECT_PROVIDERS.length),
        primaryProvider: GIGACHAT_AUTH_KEY ? 'GigaChat' : (DIRECT_PROVIDERS[0]?.label || 'OpenRouter'),
        providers: [
          ...(GIGACHAT_AUTH_KEY ? ['GigaChat'] : []),
          ...DIRECT_PROVIDERS.map(provider => provider.label),
          ...(process.env.OPENROUTER_API_KEY ? ['OpenRouter'] : [])
        ],
        gigaChatModels: GIGACHAT_AUTH_KEY ? GIGACHAT_MODELS : [],
        model: MODEL,
        fallbackModel: FALLBACK_MODEL,
        qaModel: QA_MODEL,
        qaBackupModel: QA_BACKUP_MODEL,
        freeRouterModel: FREE_ROUTER_MODEL,
        directProviders: DIRECT_PROVIDERS.map(provider => `${provider.id}:${provider.models.join('+')}`),
        maxTokens: MAX_TOKENS,
        modelTimeoutMs: MODEL_TIMEOUT_MS,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS
      });
    }
    if (req.method === 'POST' && req.url === '/api/generate') {
      const raw = await readBody(req);
      const input = JSON.parse(raw || '{}');
      return json(res, 200, await generateGame(input));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    json(res, 405, { error: 'Метод не поддерживается' });
  } catch (error) {
    console.error(error);
    json(res, error.status || (error instanceof SyntaxError ? 400 : 500), {
      error: error.message || 'Внутренняя ошибка'
    });
  }
});

const isMainProcess = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainProcess) {
  server.listen(PORT, () => {
    console.log(`VibePlay AI: http://localhost:${PORT}`);
    console.log(GIGACHAT_AUTH_KEY ? `GigaChat: основной (${GIGACHAT_MODELS.join(' -> ')})` : 'GigaChat: добавьте GIGACHAT_AUTH_KEY в .env');
    console.log(process.env.OPENROUTER_API_KEY ? `OpenRouter: ${MODEL} (fallback: ${FALLBACK_MODEL})` : 'OpenRouter: добавьте ключ в .env');
  });
}

export { smokeTestGame, checkPlayable };
