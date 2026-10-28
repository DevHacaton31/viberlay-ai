const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const elements = {
  form: $('#generateForm'),
  prompt: $('#promptInput'),
  charCount: $('#charCount'),
  button: $('#generateButton'),
  progress: $('#progressCard'),
  progressLabel: $('#progressLabel'),
  progressValue: $('#progressValue'),
  progressBar: $('#progressBar'),
  apiState: $('#apiState'),
  empty: $('#emptyState'),
  preview: $('#previewArea'),
  codeArea: $('#codeArea'),
  frame: $('#gameFrame'),
  deviceFrame: $('#deviceFrame'),
  code: $('#codeOutput'),
  title: $('#gameTitle'),
  repair: $('#repairButton'),
  history: $('#historyList'),
  download: $('#downloadButton'),
  previewTab: $('#previewTab'),
  codeTab: $('#codeTab'),
  revisionForm: $('#revisionForm'),
  revision: $('#revisionInput'),
  toast: $('#toast'),
  help: $('#helpDialog')
};

const STORAGE_KEY = 'vibeplay:games:v1';
const ANALYTICS_KEY = 'vibeplay:analytics:v1';
const icons = ['🐍', '🚀', '🧩', '🎮', '⚡', '🌟'];
let current = null;
let busy = false;
let progressTimer = null;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function notify(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => elements.toast.classList.remove('show'), 2600);
}

function cleanTitle(prompt) {
  return prompt.replace(/^(замути|сделай|создай|хочу)\s+/i, '').split(/[.:—-]/)[0].trim().slice(0, 44) || 'Новая игра';
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function getHistory() { return readJson(STORAGE_KEY, []); }

function saveGame(game) {
  const list = getHistory().filter(item => item.id !== game.id);
  list.unshift(game);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 3)));
  }
  renderHistory();
}

function renderHistory() {
  const list = getHistory();
  elements.history.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Здесь сохранятся последние генерации';
    elements.history.append(empty);
    return;
  }
  list.forEach((game, index) => {
    const button = document.createElement('button');
    button.className = 'history-item';
    button.type = 'button';
    button.innerHTML = `<span class="history-thumb">${icons[index % icons.length]}</span><span class="history-copy"><b></b><small></small></span><small>${formatDate(game.createdAt)}</small>`;
    button.querySelector('b').textContent = game.title;
    button.querySelector('.history-copy small').textContent = game.prompt;
    button.classList.toggle('active', game.id === current?.id);
    button.setAttribute('aria-label', `Запустить игру: ${game.title}`);
    button.addEventListener('click', event => {
      event.preventDefault();
      showGame(game, true);
    });
    elements.history.append(button);
  });
}

function aggregateAnalytics() {
  const events = readJson(ANALYTICS_KEY, []);
  const recent = events.slice(-100);
  return recent.reduce((result, item) => {
    result[item.event] = (result[item.event] || 0) + 1;
    return result;
  }, { generatedGames: getHistory().length });
}

function recordEvent(event, score = 0) {
  const events = readJson(ANALYTICS_KEY, []);
  events.push({ event, score: Number(score) || 0, at: Date.now(), gameId: current?.id || null });
  localStorage.setItem(ANALYTICS_KEY, JSON.stringify(events.slice(-200)));
}

function setTab(tab) {
  const isPreview = tab === 'preview';
  elements.previewTab.classList.toggle('active', isPreview);
  elements.codeTab.classList.toggle('active', !isPreview);
  elements.previewTab.setAttribute('aria-selected', String(isPreview));
  elements.codeTab.setAttribute('aria-selected', String(!isPreview));
  elements.preview.hidden = !isPreview || !current;
  elements.codeArea.hidden = isPreview || !current;
  elements.empty.hidden = Boolean(current);
}

function addTouchBridge(html, prompt = '') {
  if (html.includes('data-vibeplay-touch-bridge="3"')) return html;
  html = html.replace(/<script\b[^>]*data-vibeplay-touch-bridge[^>]*>[\s\S]*?<\/script>\s*/gi, '');
  const tapDirections = /(?:snake|зме(?:й|я|и|ек))/i.test(prompt);
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

function showGame(game, restart = false) {
  if (!game || typeof game.html !== 'string' || !game.html.trim()) {
    notify('У этой записи нет игрового HTML. Создай игру заново');
    return;
  }
  const prompt = String(game.prompt || 'Сохранённая игра');
  const playableHtml = addTouchBridge(game.html, prompt);
  if (playableHtml !== game.html) {
    game = { ...game, html: playableHtml };
    saveGame(game);
  }
  current = game;
  elements.prompt.value = prompt;
  elements.charCount.textContent = `${prompt.length} / 2000`;
  elements.title.textContent = game.title || 'Сохранённая игра';
  elements.code.textContent = game.html;
  elements.download.disabled = false;
  elements.repair.disabled = false;
  setTab('preview');
  renderHistory();

  // Повторная установка того же srcdoc не всегда перезапускает iframe.
  // Сначала очищаем документ, затем загружаем игру новым кадром.
  // setTimeout, а не requestAnimationFrame: rAF замирает в свёрнутом окне,
  // и игра оставалась бы пустым экраном до возврата на вкладку.
  if (restart || elements.frame.srcdoc === game.html) {
    elements.frame.srcdoc = '<!doctype html><html><body style="margin:0;background:#111"></body></html>';
    setTimeout(() => { elements.frame.srcdoc = game.html; }, 60);
  } else {
    elements.frame.srcdoc = game.html;
  }
  elements.preview.scrollTop = 0;
}

function setBusy(value, revision = false) {
  busy = value;
  elements.button.disabled = value;
  elements.button.classList.toggle('loading', value);
  elements.progress.hidden = !value;
  elements.revisionForm.querySelector('button').disabled = value;
  if (value) startProgress(revision);
  else stopProgress();
}

function startProgress(revision) {
  const steps = revision
    ? [['Анализируем текущую версию', 15], ['Переписываем механику', 40], ['Проверяем совместимость', 73], ['Финальная сборка', 91]]
    : [['Продумываем механику', 15], ['Пишем игровой цикл', 39], ['Добавляем управление', 62], ['Проверяем WebView', 81], ['Полируем детали', 93]];
  let index = 0;
  const update = () => {
    const [label, value] = steps[Math.min(index, steps.length - 1)];
    elements.progressLabel.textContent = label;
    elements.progressValue.textContent = `${value}%`;
    elements.progressBar.style.width = `${value}%`;
    index += 1;
  };
  update();
  progressTimer = setInterval(update, 6000);
}

function stopProgress() {
  clearInterval(progressTimer);
  elements.progressBar.style.width = '100%';
}

async function requestGame({ prompt, revision = '', currentHtml = '' }) {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, revision, currentHtml, analytics: aggregateAnalytics() })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось создать игру');
  return data;
}

async function generate(revision = '') {
  if (busy) return;
  const prompt = elements.prompt.value.trim();
  if (prompt.length < 5) {
    elements.prompt.focus();
    notify('Опиши игру чуть подробнее');
    return;
  }
  if (revision && !current) return;

  setBusy(true, Boolean(revision));
  try {
    const result = await requestGame({ prompt, revision, currentHtml: revision ? current.html : '' });
    const game = {
      id: revision ? current.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: cleanTitle(prompt),
      prompt,
      html: result.html,
      model: result.model,
      qualityChecked: Boolean(result.qualityChecked),
      createdAt: Date.now(),
      revisions: (current?.revisions || 0) + (revision ? 1 : 0)
    };
    saveGame(game);
    showGame(game);
    recordEvent(revision ? 'revision' : 'generated');
    elements.revision.value = '';
    notify(result.warnings?.length
      ? `Игра сохранена с замечанием: ${result.warnings[0]}. Нажмите «Починить игру»`
      : revision ? 'Изменения готовы' : 'Игра готова — можно играть!');
  } catch (error) {
    notify(error.message);
    if (/(?:GIGACHAT_AUTH_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY)/.test(error.message)) elements.help.showModal();
  } finally {
    setBusy(false);
  }
}

async function openDemo() {
  try {
    const response = await fetch('/demo-game.html');
    const html = await response.text();
    showGame({
      id: 'demo-lanterns',
      title: 'Сад светлячков',
      prompt: 'Добрая игра для бабушки: собирать светлячков крупной корзинкой',
      html,
      model: 'Встроенное демо',
      createdAt: Date.now(),
      revisions: 0
    });
    notify('Демо запущено');
  } catch { notify('Не удалось открыть демо'); }
}

function downloadCurrent() {
  if (!current) return;
  const blob = new Blob([current.html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${current.title.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '') || 'vibeplay-game'}.html`;
  anchor.click();
  URL.revokeObjectURL(url);
  recordEvent('download');
  notify('HTML-файл скачан');
}

elements.form.addEventListener('submit', event => { event.preventDefault(); generate(); });
elements.prompt.addEventListener('input', () => { elements.charCount.textContent = `${elements.prompt.value.length} / 2000`; });
elements.prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    generate();
  }
});
$$('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  elements.prompt.value = button.dataset.prompt;
  elements.prompt.dispatchEvent(new Event('input'));
  elements.prompt.focus();
}));
elements.previewTab.addEventListener('click', () => setTab('preview'));
elements.codeTab.addEventListener('click', () => current && setTab('code'));
elements.download.addEventListener('click', downloadCurrent);
elements.repair.addEventListener('click', () => {
  if (!current || busy) return;
  generate('Проведи полный QA игры и исправь её. Она должна гарантированно запускаться только после действия пользователя, не проигрывать сама сразу после старта, реагировать на Arrow Keys и WASD, поддерживать touch без внешних элементов оболочки, корректно завершаться и перезапускаться. Исправь также переполнение, обрезанный интерфейс и слишком быстрый темп.');
});
$('#demoButton').addEventListener('click', openDemo);
$('#copyButton').addEventListener('click', async () => {
  if (!current) return;
  await navigator.clipboard.writeText(current.html);
  notify('Код скопирован');
});
elements.revisionForm.addEventListener('submit', event => {
  event.preventDefault();
  const revision = elements.revision.value.trim();
  if (!revision) return notify('Напиши, что нужно изменить');
  generate(revision);
});
$$('[data-device]').forEach(button => button.addEventListener('click', () => {
  $$('[data-device]').forEach(item => item.classList.toggle('active', item === button));
  elements.deviceFrame.className = `device-frame ${button.dataset.device}`;
}));
function sendGameControl(key) {
  elements.frame.focus();
  elements.frame.contentWindow?.postMessage({ type: 'vibeplay:control', key }, '*');
}

window.addEventListener('keydown', event => {
  if (!current || elements.preview.hidden) return;
  if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  const keyByCode = { ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', KeyW: 'ArrowUp', KeyS: 'ArrowDown', KeyA: 'ArrowLeft', KeyD: 'ArrowRight' };
  const key = keyByCode[event.code] || keyByCode[event.key];
  if (!key) return;
  event.preventDefault();
  sendGameControl(key);
}, true);
$('#clearHistory').addEventListener('click', () => {
  if (!getHistory().length) return;
  localStorage.removeItem(STORAGE_KEY);
  renderHistory();
  notify('История очищена');
});
$('#helpButton').addEventListener('click', () => elements.help.showModal());
$('#closeHelp').addEventListener('click', () => elements.help.close());
elements.help.addEventListener('click', event => {
  if (event.target === elements.help) elements.help.close();
});
window.addEventListener('message', event => {
  if (event.source !== elements.frame.contentWindow) return;
  if (event.data?.type !== 'vibeplay:event') return;
  if (!['start', 'win', 'lose', 'restart'].includes(event.data.event)) return;
  recordEvent(event.data.event, event.data.score);
});

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    const names = data.providers?.length
      ? data.providers
      : ['OpenRouter', ...(data.directProviders || []).map(item => item.split(':')[0])];
    elements.apiState.classList.add(data.configured ? 'online' : 'warning');
    elements.apiState.querySelector('span').textContent = data.configured
      ? `AI: ${[...new Set(names)].join(' + ')}`
      : 'Нужен ключ: GigaChat / OpenRouter / Gemini';
  } catch {
    elements.apiState.classList.add('warning');
    elements.apiState.querySelector('span').textContent = 'Сервер недоступен';
  }
}

renderHistory();
checkHealth();
