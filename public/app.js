const token = new URLSearchParams(location.search).get("token");
const replyContent = document.querySelector("[data-reply-content]");
const threadInput = document.querySelector("#thread-id");
const noteList = document.querySelector("[data-note-list]");
const noteTemplate = document.querySelector("#note-template");
const sendButton = document.querySelector("[data-send-button]");
const freeformQuestion = document.querySelector("#freeform-question");
const connection = document.querySelector("[data-connection]");
const connectionLabel = document.querySelector("[data-connection-label]");
const noteCount = document.querySelector("[data-note-count]");
const replyIndex = document.querySelector("[data-reply-index]");
const toast = document.querySelector("[data-toast]");

const state = { notes: [], reply: "", threadId: "", turn: 0, streamingText: "", threads: [], hasChosenThread: false };
let eventStream;
let refreshCurrentThreadPromise;

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Tvis-Token": token, ...options.headers }
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "请求失败。");
    return body;
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function updateConnection(status) {
  const labels = { connected: "App Server 已连接", connecting: "正在连接", disconnected: "未连接" };
  connection.classList.toggle("connected", status === "connected");
  connectionLabel.textContent = labels[status] ?? status;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function markdown(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/```(?:\w+)?\n([\s\S]*?)```/g, "<pre>$1</pre>")
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^(?:-|\*) (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\n<li>)/g, "<ul>$1</ul>")
    .split(/\n{2,}/)
    .map((block) => block.startsWith("<") ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderReply(text) {
  state.reply = text;
  replyContent.innerHTML = markdown(text);
  replyIndex.textContent = state.turn ? `/${String(state.turn).padStart(2, "0")}` : "—";
}

function renderEmptyReply() {
  state.reply = "";
  state.turn = 0;
  replyIndex.textContent = "—";
  replyContent.innerHTML = '<p class="empty-copy">没内容</p>';
}

function renderNotes() {
  noteCount.textContent = state.notes.length;
  sendButton.disabled = state.notes.length === 0 && !freeformQuestion.value.trim();
  noteList.innerHTML = "";
  if (!state.notes.length) {
    noteList.innerHTML = `<p class="note-empty">选中回复中的一句话，把它放到这里继续想。</p>`;
    return;
  }
  state.notes.forEach((note, index) => {
    const element = noteTemplate.content.firstElementChild.cloneNode(true);
    element.querySelector(".note-number").textContent = `NOTE ${String(index + 1).padStart(2, "0")}`;
    element.querySelector("blockquote").textContent = note.quote;
    const textarea = element.querySelector("textarea");
    textarea.value = note.question;
    textarea.addEventListener("input", () => { note.question = textarea.value; });
    element.querySelector(".note-remove").addEventListener("click", () => {
      state.notes = state.notes.filter((item) => item.id !== note.id);
      renderNotes();
    });
    noteList.append(element);
  });
}

function selectedText() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return "";
  const range = selection.getRangeAt(0);
  if (!replyContent.contains(range.commonAncestorContainer)) return "";
  return selection.toString().replace(/\s+/g, " ").trim();
}

function addSelection() {
  const quote = selectedText();
  if (!quote) return;
  if (state.notes.some((note) => note.quote === quote)) return showToast("这段文字已经在批注中。");
  state.notes.push({ id: crypto.randomUUID(), quote, question: "" });
  window.getSelection().removeAllRanges();
  renderNotes();
  noteList.lastElementChild?.querySelector("textarea")?.focus();
}

function collectAssistantText(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) value.forEach((item) => collectAssistantText(item, output));
  else if (typeof value === "object") {
    if (typeof value.text === "string" && /agentMessage|agent|assistant/i.test(value.type ?? value.role ?? "")) output.push(value.text);
    Object.entries(value).forEach(([key, nested]) => {
      if (!["text", "type", "role"].includes(key)) collectAssistantText(nested, output);
    });
  }
  return output;
}

function loadThread(thread) {
  const assistantMessages = collectAssistantText(thread.thread?.turns ?? thread.turns);
  if (!assistantMessages.length) {
    renderEmptyReply();
    return;
  }
  state.turn = thread.thread?.turns?.length ?? thread.turns?.length ?? 1;
  renderReply(assistantMessages.at(-1));
}

function setThread(threadId) {
  const changed = state.threadId !== threadId;
  state.threadId = threadId;
  threadInput.value = threadId;
  const url = new URL(location.href);
  url.searchParams.set("thread", threadId);
  history.replaceState({}, "", url);
  if (changed) subscribeToThread();
}

function notificationThreadId(payload) {
  return payload.params?.threadId
    ?? payload.params?.thread_id
    ?? payload.params?.thread?.id
    ?? payload.params?.turn?.threadId
    ?? payload.params?.turn?.thread_id;
}

function threadLabel(thread) {
  const title = thread.name || thread.preview || "未命名会话";
  const marker = thread.loaded ? "当前 · " : "";
  return `${marker}${title.replace(/\s+/g, " ").slice(0, 90)}`;
}

function renderThreads() {
  threadInput.innerHTML = "";
  if (!state.threads.length) {
    threadInput.append(new Option("尚未找到会话", ""));
    threadInput.disabled = true;
    return;
  }
  for (const thread of state.threads) {
    const option = new Option(threadLabel(thread), thread.id, false, thread.id === state.threadId);
    option.title = `${thread.name || thread.preview || "未命名会话"}\n${thread.id}`;
    threadInput.append(option);
  }
  threadInput.disabled = false;
}

async function readThread(threadId, { announce = false } = {}) {
  const thread = await api("/api/thread/read", {
    method: "POST",
    body: JSON.stringify({ threadId })
  });
  setThread(threadId);
  loadThread(thread);
  if (announce) showToast("已切换会话。");
}

function refreshCurrentThread() {
  if (!state.threadId || refreshCurrentThreadPromise) return refreshCurrentThreadPromise;
  refreshCurrentThreadPromise = readThread(state.threadId)
    .catch((error) => {
      if (document.visibilityState === "visible") showToast(error.message);
    })
    .finally(() => {
      refreshCurrentThreadPromise = undefined;
    });
  return refreshCurrentThreadPromise;
}

async function refreshThreads({ selectDefault = false } = {}) {
  try {
    await api("/api/connect", { method: "POST" });
    const { threads = [] } = await api("/api/threads");
    state.threads = threads;
    const routeThreadId = new URLSearchParams(location.search).get("thread");
    const selectedThreadId = routeThreadId && threads.some((thread) => thread.id === routeThreadId)
      ? routeThreadId
      : state.threadId && threads.some((thread) => thread.id === state.threadId)
        ? state.threadId
        : selectDefault ? threads[0]?.id : "";
    if (!selectedThreadId) {
      renderThreads();
      renderEmptyReply();
      return;
    }
    if (selectedThreadId !== state.threadId || selectDefault) await readThread(selectedThreadId);
    renderThreads();
  } catch (error) {
    threadInput.innerHTML = "";
    threadInput.append(new Option("无法读取会话", ""));
    threadInput.disabled = true;
    renderEmptyReply();
    showToast(error.message);
  }
}

function subscribeToThread() {
  eventStream?.close();
  if (!token) return;
  const parameters = new URLSearchParams({ token });
  if (state.threadId) parameters.set("threadId", state.threadId);
  eventStream = new EventSource(`/api/events?${parameters}`);
  eventStream.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "connection") updateConnection(payload.status);
    if (payload.type !== "notification") return;
    const threadId = notificationThreadId(payload);
    if (payload.method === "thread/started" && !state.hasChosenThread) {
      if (threadId) {
        readThread(threadId).then(() => refreshThreads()).catch((error) => showToast(error.message));
      } else {
        refreshThreads({ selectDefault: true });
      }
      return;
    }
    if (payload.method === "item/agentMessage/delta") {
      const delta = payload.params.delta ?? payload.params.text ?? "";
      if (delta) {
        state.streamingText += delta;
        renderReply(state.streamingText);
      }
    }
    if (payload.method === "turn/started") {
      state.streamingText = "";
      state.turn += 1;
    }
    if (payload.method === "turn/completed") {
      if (threadId === state.threadId) {
        refreshCurrentThread();
      }
      showToast("新回复已完成。");
      return;
    }
    if (!threadId || threadId === state.threadId) {
      refreshCurrentThread();
    }
  };
}

function buildPrompt() {
  const notes = state.notes
    .map((note, index) => `${index + 1}. 引用：「${note.quote}」\n   问题：${note.question.trim() || "请解释这段话的含义、依据和下一步。"}\n`)
    .join("\n");
  const extra = freeformQuestion.value.trim();
  return `请继续处理以下阅读批注，并按编号逐项回答。引用来自你刚才的回复；如有必要，请结合完整上下文说明。\n\n${notes}${extra ? `\n补充要求：${extra}` : ""}`;
}

async function connect() {
  try {
    await api("/api/connect", { method: "POST" });
    updateConnection("connected");
    showToast("App Server 已连接。");
  } catch (error) {
    showToast(error.message);
  }
}

async function sendNotes(event) {
  event.preventDefault();
  if (!state.threadId) return showToast("先从上方选择一个会话。");
  const text = buildPrompt();
  try {
    await api("/api/turn/start", { method: "POST", body: JSON.stringify({ threadId: state.threadId, text }) });
    state.notes = [];
    freeformQuestion.value = "";
    renderNotes();
    showToast("已发送到原会话，正在等待新回复。");
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("[data-action='refresh-threads']").addEventListener("click", () => refreshThreads({ selectDefault: !state.threadId }));
threadInput.addEventListener("change", async () => {
  const threadId = threadInput.value;
  if (!threadId || threadId === state.threadId) return;
  state.hasChosenThread = true;
  try {
    await readThread(threadId, { announce: true });
  } catch (error) {
    showToast(error.message);
    renderThreads();
  }
});
document.querySelector("[data-action='clear-notes']").addEventListener("click", () => { state.notes = []; renderNotes(); });
document.querySelector("[data-composer]").addEventListener("submit", sendNotes);
freeformQuestion.addEventListener("input", renderNotes);
replyContent.addEventListener("mouseup", () => setTimeout(addSelection));
replyContent.addEventListener("keyup", (event) => {
  if (event.key === "Enter" && event.shiftKey) addSelection();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") document.querySelector("[data-composer]").requestSubmit();
});

if (!token) showToast("缺少访问令牌。请从 npm start 输出的完整 URL 打开页面。");
else {
  const routeThreadId = new URLSearchParams(location.search).get("thread");
  if (routeThreadId) {
    state.threadId = routeThreadId;
    state.hasChosenThread = true;
  }
  api("/api/status").then((status) => updateConnection(status.status)).catch(() => updateConnection("disconnected"));
  subscribeToThread();
  refreshThreads({ selectDefault: !routeThreadId });
  setInterval(() => {
    if (document.visibilityState === "visible") refreshCurrentThread();
  }, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshCurrentThread();
  });
}

renderNotes();
