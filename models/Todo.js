const mongoose = require('mongoose')

const TodoSchema = new mongoose.Schema({
  text: { type: String, required: true },
  completed: { type: Boolean, default: false },
  category: { type: String, default: 'other' },
  priority: { type: String, default: 'low' },
  dueDate: { type: String, default: null }, // store as 'YYYY-MM-DD' string
  dueTime: { type: String, default: null }, // store as 'HH:MM' string
  position: { type: Number, default: 0 }
}, { timestamps: true })

module.exports = mongoose.model('Todo', TodoSchema)
