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
    return docs.map(d => ({ id: String(d._id), text: d.text, completed: d.completed, category: d.category, priority: d.priority, position: d.position, dueDate: d.dueDate || null, dueTime: d.dueTime || null, dependencies: d.dependencies || [], locked: !!d.locked }))
  }
  return inMemory.slice().map(d => ({ ...d }))
}

async function replaceAllTodos(todos) {
  if (mongoose.connection.readyState === 1) {
    // simple replace strategy: remove all and insert provided (not ideal for production)
    await Todo.deleteMany({})
    const docs = await Todo.insertMany(todos.map((t, i) => ({ text: t.text, completed: !!t.completed, category: t.category || 'other', priority: t.priority || 'low', dueDate: t.dueDate || null, dueTime: t.dueTime || null, dependencies: t.dependencies || [], locked: !!t.locked, position: i })))
    return docs.map(d => ({ id: String(d._id), text: d.text, completed: d.completed, category: d.category, priority: d.priority, position: d.position, dueDate: d.dueDate || null, dueTime: d.dueTime || null, dependencies: d.dependencies || [], locked: !!d.locked }))
  }
  inMemory = todos.map((t, i) => ({ id: t.id || ('m_' + Date.now() + '_' + i), text: t.text, completed: !!t.completed, category: t.category || 'other', priority: t.priority || 'low', dueDate: t.dueDate || null, dueTime: t.dueTime || null, dependencies: t.dependencies || [], locked: !!t.locked, position: i }))
  return inMemory.slice()
}

// helpers for automation
function computePriorityByDue(dueDate, dueTime) {
  if (!dueDate) return null
  try {
    const target = new Date(dueDate + (dueTime ? ('T' + dueTime + ':00') : 'T00:00:00'))
    const now = new Date()
    const diff = target - now
    const day = 24 * 60 * 60 * 1000
    if (diff <= 0) return 'high'
    if (diff <= day) return 'high'
    if (diff <= 3 * day) return 'medium'
    return null
  } catch (e) { return null }
}

async function computeLockedFor(id, deps) {
  if (!Array.isArray(deps) || deps.length === 0) return false
  if (mongoose.connection.readyState === 1) {
    const docs = await Todo.find({ _id: { $in: deps } }).lean()
    const allDone = docs.every(d => d && d.completed)
    return !allDone
  }
  // in-memory
  return deps.some(dep => {
    const t = inMemory.find(x => x.id === dep)
    return !(t && t.completed)
  })
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
      // compute automated priority if due date suggests escalation
      const auto = computePriorityByDue(todo.dueDate, todo.dueTime)
      const priority = todo.priority || auto || 'low'
      const deps = Array.isArray(todo.dependencies) ? todo.dependencies : []
      const locked = await computeLockedFor(null, deps)
      const doc = await Todo.create({ text: todo.text, completed: !!todo.completed, category: todo.category || 'other', priority, dueDate: todo.dueDate || null, dueTime: todo.dueTime || null, dependencies: deps, locked: locked, position: pos })
      const real = { id: String(doc._id), text: doc.text, completed: doc.completed, category: doc.category, priority: doc.priority, position: doc.position, dueDate: doc.dueDate || null, dueTime: doc.dueTime || null, dependencies: doc.dependencies || [], locked: !!doc.locked }
      // confirm optimistic
      if (tempId) ws.send(JSON.stringify({ type: 'sync:confirm', payload: { tempId, realId: real.id } }))
      // broadcast new todo
      broadcast({ type: 'sync:update', payload: { todo: real } }, ws)
    } else {
      // in-memory
      const id = 'm_' + Date.now()
      const auto = computePriorityByDue(todo.dueDate, todo.dueTime)
      const priority = todo.priority || auto || 'low'
      const deps = Array.isArray(todo.dependencies) ? todo.dependencies : []
      const locked = await computeLockedFor(null, deps)
      const obj = { id, text: todo.text, completed: !!todo.completed, category: todo.category || 'other', priority, dueDate: todo.dueDate || null, dueTime: todo.dueTime || null, dependencies: deps, locked: locked, position: inMemory.length }
      inMemory.unshift(obj)
      if (tempId) ws.send(JSON.stringify({ type: 'sync:confirm', payload: { tempId, realId: obj.id } }))
      broadcast({ type: 'sync:update', payload: { todo: obj } }, ws)
    }
    return
  }

  if (type === 'todo:edit') {
    const { id, text, category, priority, dueDate, dueTime, dependencies } = payload || {}
    if (!id) return
    if (mongoose.connection.readyState === 1) {
      // if dependencies changed or due date changed, recompute locked/priority
      const deps = Array.isArray(dependencies) ? dependencies : undefined
      const update = { updatedAt: Date.now() }
      if (text !== undefined) update.text = text
      if (category !== undefined) update.category = category
      if (dueDate !== undefined) update.dueDate = dueDate || null
      if (dueTime !== undefined) update.dueTime = dueTime || null
      // compute priority if not explicitly provided
      const auto = computePriorityByDue(dueDate, dueTime)
      update.priority = priority || auto || 'low'
      if (deps !== undefined) update.dependencies = deps
      await Todo.findByIdAndUpdate(id, update).lean()
      const doc = await Todo.findById(id).lean()
      // ensure locked reflects current dependency state
      const locked = await computeLockedFor(id, doc.dependencies || [])
      if (locked !== !!doc.locked) {
        await Todo.findByIdAndUpdate(id, { locked })
        doc.locked = locked
      }
      const t = { id: String(doc._id), text: doc.text, completed: doc.completed, category: doc.category, priority: doc.priority, position: doc.position, dueDate: doc.dueDate || null, dueTime: doc.dueTime || null, dependencies: doc.dependencies || [], locked: !!doc.locked }
      broadcast({ type: 'sync:update', payload: { todo: t } })
    } else {
      const idx = inMemory.findIndex(x => x.id === id)
      if (idx !== -1) {
        if (text !== undefined) inMemory[idx].text = text
        if (category !== undefined) inMemory[idx].category = category || inMemory[idx].category
        if (dueDate !== undefined) inMemory[idx].dueDate = dueDate || null
        if (dueTime !== undefined) inMemory[idx].dueTime = dueTime || null
        const auto = computePriorityByDue(dueDate, dueTime)
        inMemory[idx].priority = priority || auto || inMemory[idx].priority || 'low'
        if (Array.isArray(dependencies)) inMemory[idx].dependencies = dependencies
        // recompute locked
        inMemory[idx].locked = await computeLockedFor(id, inMemory[idx].dependencies || [])
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
      const updated = { id: String(doc._id), text: doc.text, completed: doc.completed, category: doc.category, priority: doc.priority, position: doc.position, dueDate: doc.dueDate || null, dueTime: doc.dueTime || null, dependencies: doc.dependencies || [], locked: !!doc.locked }
      broadcast({ type: 'sync:update', payload: { todo: updated } })
      // if completed, check dependents to possibly unlock them
      if (doc.completed) {
        const dependents = await Todo.find({ dependencies: String(doc._id) }).lean()
        for (const dep of dependents) {
          const locked = await computeLockedFor(dep._id, dep.dependencies || [])
          if (!locked && dep.locked) {
            await Todo.findByIdAndUpdate(dep._id, { locked: false })
            const newDoc = await Todo.findById(dep._id).lean()
            broadcast({ type: 'sync:update', payload: { todo: { id: String(newDoc._id), text: newDoc.text, completed: newDoc.completed, category: newDoc.category, priority: newDoc.priority, position: newDoc.position, dueDate: newDoc.dueDate || null, dueTime: newDoc.dueTime || null, dependencies: newDoc.dependencies || [], locked: false } } })
            // send a gentle reminder notification to clients
            broadcast({ type: 'todo:reminder', payload: { id: String(newDoc._id), message: 'A dependency finished — this task is unlocked.' } })
          }
        }
      }
    } else {
      const idx = inMemory.findIndex(x => x.id === id)
      if (idx !== -1) {
        inMemory[idx].completed = !inMemory[idx].completed
        broadcast({ type: 'sync:update', payload: { todo: inMemory[idx] } })
        if (inMemory[idx].completed) {
          // find dependents in-memory
          for (const other of inMemory) {
            if (Array.isArray(other.dependencies) && other.dependencies.includes(inMemory[idx].id)) {
              const locked = other.dependencies.some(dep => {
                const t = inMemory.find(x => x.id === dep)
                return !(t && t.completed)
              })
              if (!locked && other.locked) {
                other.locked = false
                broadcast({ type: 'sync:update', payload: { todo: other } })
                broadcast({ type: 'todo:reminder', payload: { id: other.id, message: 'A dependency finished — this task is unlocked.' } })
              }
            }
          }
        }
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
