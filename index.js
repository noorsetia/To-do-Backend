require('dotenv').config()
const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const cors = require('cors')
const mongoose = require('mongoose')
const Todo = require('./models/Todo')

const PORT = process.env.PORT || 4000
const MONGO = process.env.MONGO_URI || process.env.MONGODB_URI || ''

const app = express()
app.use(cors())
app.use(express.json())

// In-memory fallback store used if no MongoDB provided
let inMemory = []

async function getAllTodos() {
  if (mongoose.connection.readyState === 1) {
    const docs = await Todo.find({}).sort({ position: 1, createdAt: -1 }).lean()
    return docs.map(d => ({ id: String(d._id), text: d.text, completed: d.completed, category: d.category, priority: d.priority, position: d.position, dueDate: d.dueDate || null, dueTime: d.dueTime || null }))
  }
  return inMemory.slice().map(d => ({ ...d }))
}

async function replaceAllTodos(todos) {
  if (mongoose.connection.readyState === 1) {
    // simple replace strategy: remove all and insert provided (not ideal for production)
    await Todo.deleteMany({})
    const docs = await Todo.insertMany(todos.map((t, i) => ({ text: t.text, completed: !!t.completed, category: t.category || 'other', priority: t.priority || 'low', dueDate: t.dueDate || null, dueTime: t.dueTime || null, position: i })))
    return docs.map(d => ({ id: String(d._id), text: d.text, completed: d.completed, category: d.category, priority: d.priority, position: d.position, dueDate: d.dueDate || null, dueTime: d.dueTime || null }))
  }
  inMemory = todos.map((t, i) => ({ id: t.id || ('m_' + Date.now() + '_' + i), text: t.text, completed: !!t.completed, category: t.category || 'other', priority: t.priority || 'low', dueDate: t.dueDate || null, dueTime: t.dueTime || null, position: i }))
  return inMemory.slice()
}

// REST endpoints for optional usage
app.get('/api/todos', async (req, res) => {
  try {
    const todos = await getAllTodos()
    res.json({ todos })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/todos', async (req, res) => {
  try {
    const { text, category = 'other', priority = 'low', dueDate = null, dueTime = null } = req.body
    if (!text) return res.status(400).json({ error: 'text required' })
    if (mongoose.connection.readyState === 1) {
      const last = await Todo.findOne().sort({ position: -1 }).lean()
      const pos = last ? (last.position || 0) + 1 : 0
      const doc = await Todo.create({ text, completed: false, category, priority, dueDate: dueDate || null, dueTime: dueTime || null, position: pos })
      return res.json({ todo: { id: String(doc._id), text: doc.text, completed: doc.completed, category: doc.category, priority: doc.priority, position: doc.position, dueDate: doc.dueDate || null, dueTime: doc.dueTime || null } })
    }
    const id = 'm_' + Date.now()
    const obj = { id, text, completed: false, category, priority, dueDate: dueDate || null, dueTime: dueTime || null, position: inMemory.length }
    inMemory.unshift(obj)
    return res.json({ todo: obj })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// create server and websocket
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

function broadcast(message, except) {
  const raw = JSON.stringify(message)
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c !== except) {
      c.send(raw)
    }
  })
}

wss.on('connection', async function connection(ws) {
  // send initial state
  try {
    const todos = await getAllTodos()
    ws.send(JSON.stringify({ type: 'sync:replace', payload: { todos } }))
  } catch (e) {}

  ws.on('message', async function incoming(message) {
    try {
      const msg = JSON.parse(message)
      await handleMessage(ws, msg)
    } catch (err) {
      // ignore malformed
    }
  })
})

async function handleMessage(ws, msg) {
  const { type, payload } = msg || {}
  if (!type) return

  if (type === 'sync:request') {
    const todos = await getAllTodos()
    ws.send(JSON.stringify({ type: 'sync:replace', payload: { todos } }))
    return
  }

  if (type === 'todo:add') {
    // payload may include temp id
    const todo = payload || {}
    const tempId = todo.id
    // persist
    if (mongoose.connection.readyState === 1) {
      const last = await Todo.findOne().sort({ position: -1 }).lean()
      const pos = last ? (last.position || 0) + 1 : 0
      const doc = await Todo.create({ text: todo.text, completed: !!todo.completed, category: todo.category || 'other', priority: todo.priority || 'low', dueDate: todo.dueDate || null, dueTime: todo.dueTime || null, position: pos })
      const real = { id: String(doc._id), text: doc.text, completed: doc.completed, category: doc.category, priority: doc.priority, position: doc.position, dueDate: doc.dueDate || null, dueTime: doc.dueTime || null }
      // confirm optimistic
      if (tempId) ws.send(JSON.stringify({ type: 'sync:confirm', payload: { tempId, realId: real.id } }))
      // broadcast new todo
      broadcast({ type: 'sync:update', payload: { todo: real } }, ws)
    } else {
      // in-memory
      const id = 'm_' + Date.now()
      const obj = { id, text: todo.text, completed: !!todo.completed, category: todo.category || 'other', priority: todo.priority || 'low', dueDate: todo.dueDate || null, dueTime: todo.dueTime || null, position: inMemory.length }
      inMemory.unshift(obj)
      if (tempId) ws.send(JSON.stringify({ type: 'sync:confirm', payload: { tempId, realId: obj.id } }))
      broadcast({ type: 'sync:update', payload: { todo: obj } }, ws)
    }
    return
  }

  if (type === 'todo:edit') {
    const { id, text, category, priority, dueDate, dueTime } = payload || {}
    if (!id) return
    if (mongoose.connection.readyState === 1) {
      await Todo.findByIdAndUpdate(id, { text, category, priority, dueDate: dueDate || null, dueTime: dueTime || null, updatedAt: Date.now() }).lean()
      const doc = await Todo.findById(id).lean()
      const t = { id: String(doc._id), text: doc.text, completed: doc.completed, category: doc.category, priority: doc.priority, position: doc.position, dueDate: doc.dueDate || null, dueTime: doc.dueTime || null }
      broadcast({ type: 'sync:update', payload: { todo: t } })
    } else {
      const idx = inMemory.findIndex(x => x.id === id)
      if (idx !== -1) {
        inMemory[idx].text = text
        inMemory[idx].category = category || inMemory[idx].category
        inMemory[idx].priority = priority || inMemory[idx].priority
        inMemory[idx].dueDate = dueDate || null
        inMemory[idx].dueTime = dueTime || null
        broadcast({ type: 'sync:update', payload: { todo: inMemory[idx] } })
      }
    }
    return
  }

  if (type === 'todo:remove') {
    const { id } = payload || {}
    if (!id) return
    if (mongoose.connection.readyState === 1) {
      await Todo.findByIdAndDelete(id)
      broadcast({ type: 'sync:replace', payload: { todos: await getAllTodos() } })
    } else {
      inMemory = inMemory.filter(x => x.id !== id)
      broadcast({ type: 'sync:replace', payload: { todos: inMemory.slice() } })
    }
    return
  }

  if (type === 'todo:toggle') {
    const { id } = payload || {}
    if (!id) return
    if (mongoose.connection.readyState === 1) {
      const doc = await Todo.findById(id)
      if (!doc) return
      doc.completed = !doc.completed
      await doc.save()
      broadcast({ type: 'sync:update', payload: { todo: { id: String(doc._id), text: doc.text, completed: doc.completed, category: doc.category, priority: doc.priority, position: doc.position, dueDate: doc.dueDate || null, dueTime: doc.dueTime || null } } })
    } else {
      const idx = inMemory.findIndex(x => x.id === id)
      if (idx !== -1) {
        inMemory[idx].completed = !inMemory[idx].completed
        broadcast({ type: 'sync:update', payload: { todo: inMemory[idx] } })
      }
    }
    return
  }

  if (type === 'todo:clearCompleted') {
    if (mongoose.connection.readyState === 1) {
      await Todo.deleteMany({ completed: true })
      broadcast({ type: 'sync:replace', payload: { todos: await getAllTodos() } })
    } else {
      inMemory = inMemory.filter(x => !x.completed)
      broadcast({ type: 'sync:replace', payload: { todos: inMemory.slice() } })
    }
    return
  }

  if (type === 'todo:clearAll' || type === 'todo:removeAll') {
    if (mongoose.connection.readyState === 1) {
      await Todo.deleteMany({})
      broadcast({ type: 'sync:replace', payload: { todos: [] } })
    } else {
      inMemory = []
      broadcast({ type: 'sync:replace', payload: { todos: [] } })
    }
    return
  }

  if (type === 'todo:reorder') {
    const { order } = payload || {}
    if (!Array.isArray(order)) return
    if (mongoose.connection.readyState === 1) {
      // apply new positions
      for (let i = 0; i < order.length; i++) {
        const id = order[i]
        await Todo.findByIdAndUpdate(id, { position: i })
      }
      broadcast({ type: 'sync:replace', payload: { todos: await getAllTodos() } })
    } else {
      // reorder inMemory
      const map = {}
      inMemory.forEach(t => map[t.id] = t)
      inMemory = order.map((id, i) => ({ ...(map[id] || { id, text: '', completed: false }), position: i }))
      broadcast({ type: 'sync:replace', payload: { todos: inMemory.slice() } })
    }
    return
  }

  if (type === 'todo:restoreMany') {
    const { items } = payload || {}
    if (!Array.isArray(items)) return
    if (mongoose.connection.readyState === 1) {
      await Todo.insertMany(items.map((t, i) => ({ text: t.text, completed: !!t.completed, category: t.category || 'other', priority: t.priority || 'low', position: Date.now() + i })))
      broadcast({ type: 'sync:replace', payload: { todos: await getAllTodos() } })
    } else {
      inMemory = [...items, ...inMemory]
      broadcast({ type: 'sync:replace', payload: { todos: inMemory.slice() } })
    }
    return
  }
}

// connect to Mongo if provided
async function start() {
  if (MONGO) {
    try {
      await mongoose.connect(MONGO)
      console.log('Connected to MongoDB')
    } catch (e) {
      console.warn('Failed to connect to MongoDB, using in-memory store')
    }
  } else {
    console.log('No MongoDB configured, using in-memory store')
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
  })
}

start()
