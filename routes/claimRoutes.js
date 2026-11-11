const express = require('express');
const router = express.Router();
const Claim = require('../models/Claim');
const Item = require('../models/Item');
const { protect } = require('../middleware/authMiddleware');
const mongoose = require('mongoose');

const getUserId = (user) => {
  if (!user) return null;
  if (user._id) return user._id.toString();
  return user.toString();
};

router.post('/', protect, async (req, res) => {
  try {
    const { itemId, message, answers } = req.body;
    const currentUserId = getUserId(req.user);

    if (!currentUserId) {
      return res.status(401).json({ message: 'User authentication failed.' });
    }

    if (!itemId || !message || !String(message).trim()) {
      return res.status(400).json({ message: 'Item ID and message are required' });
    }

    if (!mongoose.isValidObjectId(itemId)) {
      return res.status(400).json({ message: 'Invalid matched item ID' });
    }

    const item = await Item.findById(itemId);
    if (!item) {
      return res.status(404).json({ message: 'Item not found in database' });
    }

    if (item.status !== 'open') {
      return res.status(400).json({ message: 'This item is no longer available for claim requests.' });
    }

    const itemOwnerId = getUserId(item.user);
    if (!itemOwnerId) {
      return res.status(400).json({ message: 'The item owner could not be identified.' });
    }

    if (itemOwnerId === currentUserId) {
      return res.status(400).json({ message: 'Aap apne hi posted item par claim request nahi bhej sakte.' });
    }

    const existingClaim = await Claim.findOne({ item: itemId, requestedBy: currentUserId });
    if (existingClaim) {
      return res.status(400).json({ message: 'Aap pehle hi is item par claim request submit kar chuke hain.' });
    }

    const claim = await Claim.create({
      item: itemId,
      requestedBy: currentUserId,
      owner: itemOwnerId,
      message: String(message).trim(),
      answers: answers || { q1: "", q2: "", q3: "" },
      status: 'Pending'
    });

    const populatedClaim = await Claim.findById(claim._id)
      .populate('item')
      .populate('requestedBy', 'name email phone');

    res.status(201).json({ 
      message: 'Claim request sent successfully', 
      claim: populatedClaim 
    });
  } catch (err) {
    console.error("[Create Claim Error]:", err);
    res.status(500).json({ message: 'Server error while creating claim', error: err.message });
  }
});

router.get('/received', protect, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const claims = await Claim.find({ owner: userId })
      .populate('item')
      .populate('requestedBy', 'name email phone')
      .sort({ createdAt: -1 });

    res.status(200).json(claims);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/my-claims', protect, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const claims = await Claim.find({ requestedBy: userId })
      .populate('item')
      .populate('owner', 'name email phone')
      .sort({ createdAt: -1 });

    res.status(200).json(claims);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.put('/:id', protect, async (req, res) => {
  try {
    const { status } = req.body;
    const userId = getUserId(req.user);

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status value' });
    }

    const claim = await Claim.findById(req.params.id);
    if (!claim) return res.status(404).json({ message: 'Claim request not found' });

    if (claim.owner.toString() !== userId) {
      return res.status(403).json({ message: 'Not authorized to modify this claim' });
    }

    claim.status = status;
    await claim.save();

    if (status === 'Approved') {
      await Item.findByIdAndUpdate(claim.item, { status: 'resolved' });
      await Claim.updateMany(
        { item: claim.item, _id: { $ne: claim._id }, status: 'Pending' },
        { status: 'Rejected' }
      );
    }

    res.status(200).json({ message: `Claim ${status.toLowerCase()} successfully`, claim });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;