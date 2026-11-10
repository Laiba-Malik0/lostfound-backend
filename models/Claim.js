
const mongoose = require('mongoose');

const claimSchema = new mongoose.Schema({
  item: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Item',
    required: true
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  answers: {
    q1: { type: String, default: "" },
    q2: { type: String, default: "" },
    q3: { type: String, default: "" }
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected', 'Locked'],
    default: 'Pending'
  }
}, {
  timestamps: true
});

module.exports = mongoose.models.Claim ||
  mongoose.model('Claim', claimSchema);
