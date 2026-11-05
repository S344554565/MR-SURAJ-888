const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { PORT, JWT_SECRET, JWT_EXPIRES, OWNER, APP_NAME } = require('./config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// ================= OWNER BANNER =================
const banner = `
╔══════════════════════════════════════════════╗
║                                              ║
║        🚀  ${APP_NAME}  🚀             ║
║                                              ║
║           OWNER : ${OWNER}             ║
║                                              ║
╚══════════════════════════════════════════════╝
`;

// ================= IN-MEMORY DB =================
const users = [];      // { id, username, passwordHash }
const messages = [];   // { id, from, to, text, timestamp }

// ================= HELPERS =================
const generateToken = (user) =>
  jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES
  });

const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Token missing', owner: OWNER });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', owner: OWNER });
  }
};

// ================= ROOT / HEALTH =================
app.get('/', (req, res) => {
  res.json({
    app: APP_NAME,
    owner: OWNER,
    status: 'online ✅',
    version: '1.0.0',
    time: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    owner: OWNER,
    app: APP_NAME,
    users: users.length,
    messages: messages.length,
    uptime: process.uptime()
  });
});

// ================= AUTH ROUTES =================

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username & password required', owner: OWNER });

  if (users.find(u => u.username === username))
    return res.status(409).json({ error: 'User already exists', owner: OWNER });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: Date.now().toString(), username, passwordHash };
  users.push(user);

  const token = generateToken(user);
  res.json({
    message: `Welcome to ${APP_NAME}!`,
    owner: OWNER,
    token,
    user: { id: user.id, username }
  });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials', owner: OWNER });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials', owner: OWNER });

  const token = generateToken(user);
  res.json({
    message: `Welcome back to ${APP_NAME}!`,
    owner: OWNER,
    token,
    user: { id: user.id, username }
  });
});

// Profile
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ owner: OWNER, app: APP_NAME, user: req.user });
});

// ================= MESSAGE ROUTES =================

// Get conversation
app.get('/api/messages/:userId', authMiddleware, (req, res) => {
  const myId = req.user.id;
  const otherId = req.params.userId;
  const chat = messages.filter(
    m => (m.from === myId && m.to === otherId) ||
         (m.from === otherId && m.to === myId)
  );
  res.json({ owner: OWNER, messages: chat });
});

// Send message (REST fallback)
app.post('/api/messages', authMiddleware, (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ error: 'to & text required', owner: OWNER });

  const msg = {
    id: Date.now().toString(),
    from: req.user.id,
    to,
    text,
    timestamp: new Date().toISOString()
  };
  messages.push(msg);

  const receiverSocket = onlineUsers.get(to);
  if (receiverSocket) io.to(receiverSocket).emit('message:new', msg);

  res.json({ owner: OWNER, message: msg });
});

// List users
app.get('/api/users', authMiddleware, (req, res) => {
  const list = users
    .filter(u => u.id !== req.user.id)
    .map(u => ({ id: u.id, username: u.username }));
  res.json({ owner: OWNER, users: list });
});

// ================= SOCKET.IO =================
const onlineUsers = new Map(); // userId -> socketId

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token required'));

  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const { id, username } = socket.user;
  onlineUsers.set(id, socket.id);

  console.log(`🟢 [${OWNER}] ${username} connected (${id})`);

  // Welcome with owner branding
  socket.emit('welcome', {
    message: `Welcome to ${APP_NAME}!`,
    owner: OWNER,
    you: { id, username }
  });

  socket.broadcast.emit('user:online', { id, username });

  // direct message
  socket.on('message:send', ({ to, text }) => {
    if (!to || !text) return;

    const msg = {
      id: Date.now().toString(),
      from: id,
      to,
      text,
      timestamp: new Date().toISOString()
    };
    messages.push(msg);

    const receiverSocket = onlineUsers.get(to);
    if (receiverSocket) io.to(receiverSocket).emit('message:new', msg);

    socket.emit('message:sent', msg);
  });

  // typing
  socket.on('typing', ({ to }) => {
    const receiverSocket = onlineUsers.get(to);
    if (receiverSocket) io.to(receiverSocket).emit('typing', { from: id });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(id);
    console.log(`🔴 [${OWNER}] ${username} disconnected`);
    socket.broadcast.emit('user:offline', { id });
  });
});

// ================= START =================
server.listen(PORT, () => {
  console.log(banner);
  console.log(`🚀 ${APP_NAME} running on http://localhost:${PORT}`);
  console.log(`👑 Owner: ${OWNER}`);
  console.log(`⏰ Started: ${new Date().toLocaleString()}\n`);
});
