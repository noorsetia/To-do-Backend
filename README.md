# To‑Do Backend

This is the backend for the To‑Do fullstack demo. It provides a minimal REST API and a WebSocket server used by the frontend for real‑time sync. The server uses MongoDB when a connection string is provided; otherwise it falls back to an in‑memory store.

Features
- REST endpoints: GET /api/todos, POST /api/todos
- WebSocket server for real-time sync and optimistic update confirmations
- Optional MongoDB persistence via MONGO_URI; in-memory fallback if not configured

Prerequisites
- Node.js (16+ recommended)
- (Optional) MongoDB if you want persistent storage

Quick start
1. Install dependencies
   npm install

2. Configure environment (optional)
   Create a .env file or set environment variables:
   - PORT — port to run the server (default: 4000)
   - MONGO_URI or MONGODB_URI — MongoDB connection string (optional)

3. Run the server
   node index.js

If MongoDB is not configured the server runs with an in-memory store.

REST API
- GET /api/todos
  Returns: { todos: [...] }

- POST /api/todos
  Body: { text, category?, priority?, dueDate?, dueTime? }
  Returns: { todo: { id, text, completed, category, priority, position, dueDate, dueTime } }

WebSocket protocol
- Connect to the same host/port with a WebSocket client.
- Messages are JSON objects with a `type` and optional `payload`.

Important message types used by the frontend:
- sync:request — client requests the full state
- sync:replace — server sends a full list of todos: payload: { todos }
- sync:update — server sends upsert of a single todo: payload: { todo }
- sync:confirm — server confirms optimistic add: payload: { tempId, realId }
- sync:reject — server rejects an optimistic operation

Client -> server actions (examples):
- todo:add — payload: todo object (may include a temp id)
- todo:edit — payload: { id, text, category, priority, dueDate, dueTime }
- todo:remove — payload: { id }
- todo:toggle — payload: { id }
- todo:clearCompleted, todo:clearAll, todo:reorder, todo:restoreMany

Development notes
- The current implementation replaces database contents on some operations; it's intended as a demo not a production-ready API.
- Models are in `models/Todo.js`. See `index.js` for the WebSocket message handling logic.

License
MIT (or whatever license you prefer)