// public/js/chat.js
let chatSocket = null;
let currentUser = null;

function initChat(user) {
  currentUser = user;
  if (!user) return;

  // Connect to Socket.io
  chatSocket = io();

  // Join the user's room
  chatSocket.emit('join_room', user.id);

  // Load chat history
  loadChatHistory();

  // Listen for new messages
  chatSocket.on('new_message', (msg) => {
    appendMessage(msg, msg.sender === 'support' ? false : true);
    // If chat is closed, show badge
    const box = document.getElementById('chatBox');
    if (!box || box.classList.contains('d-none')) {
      const badge = document.getElementById('chatBadge');
      if (badge) {
        let count = parseInt(badge.textContent) || 0;
        count++;
        badge.textContent = count > 9 ? '9+' : count;
        badge.classList.remove('d-none');
      }
    }
  });
}

async function loadChatHistory() {
  try {
    const res = await fetch('/api/chat/messages');
    const messages = await res.json();
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    if (messages.length === 0) {
      container.innerHTML = '<div class="chat-welcome">👋 Hi! How can we help you today?</div>';
    } else {
      messages.forEach(msg => appendMessage(msg, msg.sender === 'client'));
    }
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.error('Failed to load chat history', err);
  }
}

function appendMessage(msg, isMine) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
  div.innerHTML = `
    <div class="msg-bubble">${escapeHtml(msg.body)}</div>
    <div class="msg-time">${new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const body = input?.value.trim();
  if (!body || !chatSocket || !currentUser) return;
  chatSocket.emit('send_message', { body, targetUserId: currentUser.id });
  input.value = '';
}

function toggleChat() {
  const box = document.getElementById('chatBox');
  if (!box) return;
  const isOpen = !box.classList.contains('d-none');
  if (isOpen) {
    box.classList.add('d-none');
  } else {
    box.classList.remove('d-none');
    document.getElementById('chatBadge')?.classList.add('d-none');
    loadChatHistory();
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

// Auto-initialize after DOM and user data is ready
document.addEventListener('DOMContentLoaded', async () => {
  // Wait for user data (nav.js sets user, but we can also fetch)
  const res = await fetch('/api/me');
  if (res.ok) {
    const user = await res.json();
    if (user && user.role === 'client') {
      initChat(user);
    }
  }
});