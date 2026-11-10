
const express = require('express');
const router = express.Router();
const Claim = require('../models/Claim');
const Item = require('../models/Item');
const { protect } = require('../middleware/authMiddleware');

const getUserId = (user) => {
  if (!user) return null;
  return (user._id || user.id || user).toString();
};

// CREATE CLAIM
router.post('/', protect, async (req, res) => {
  try {
    const { itemId, message, answers } = req.body;
    const currentUserId = getUserId(req.user);

    if (!currentUserId) {
      return res.status(401).json({
        message: 'User authentication failed.'
      });
    }

    if (!itemId || !message) {
      return res.status(400).json({
        message: 'Item ID and message are required'
      });
    }

    const item = await Item.findById(itemId);

    if (!item) {
      return res.status(404).json({
        message: 'Item not found in database'
      });
    }

    const itemOwnerId = getUserId(item.user);

    if (itemOwnerId === currentUserId) {
      return res.status(400).json({
        message: 'Aap apne hi posted item par claim request nahi bhej sakte.'
      });
    }

    if (item.status === 'resolved') {
      return res.status(400).json({
        message: 'This item has already been resolved. Claims are closed.'
      });
    }

    const existingClaim = await Claim.findOne({
      item: itemId,
      requestedBy: currentUserId
    });

    if (existingClaim) {
      return res.status(400).json({
        message: 'Aap pehle hi is item par claim request submit kar chuke hain.'
      });
    }

    const claim = await Claim.create({
      item: itemId,
      requestedBy: currentUserId,
      owner: itemOwnerId,
      message,
      answers: answers || {
        q1: "",
        q2: "",
        q3: ""
      },
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
    console.error('[Create Claim Error]:', err);

    res.status(500).json({
      message: 'Server error while creating claim',
      error: err.message
    });
  }
});


// RECEIVED CLAIMS
router.get('/received', protect, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const claims = await Claim.find({ owner: userId })
      .populate('item')
      .populate('requestedBy', 'name email phone')
      .sort({ createdAt: -1 });

    res.status(200).json(claims);

  } catch (err) {
    res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
});


// MY CLAIMS
router.get('/my-claims', protect, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const claims = await Claim.find({ requestedBy: userId })
      .populate('item')
      .populate('owner', 'name email phone')
      .sort({ createdAt: -1 });

    res.status(200).json(claims);

  } catch (err) {
    res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
});


// APPROVE / REJECT CLAIM
router.put('/:id', protect, async (req, res) => {
  try {
    const { status } = req.body;
    const userId = getUserId(req.user);

    if (!userId) {
      return res.status(401).json({
        message: 'Unauthorized'
      });
    }

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({
        message: 'Invalid status value'
      });
    }

    const claim = await Claim.findById(req.params.id);

    if (!claim) {
      return res.status(404).json({
        message: 'Claim request not found'
      });
    }

    // Only item owner can update claim
    if (claim.owner.toString() !== userId) {
      return res.status(403).json({
        message: 'Not authorized to modify this claim'
      });
    }

    // Locked claims cannot be modified
    if (claim.status === 'Locked') {
      return res.status(400).json({
        message: 'This claim is locked and cannot be modified.'
      });
    }

    // Only pending claims can be updated
    if (claim.status !== 'Pending') {
      return res.status(400).json({
        message: `This claim is already ${claim.status}.`
      });
    }

    // Check item status before approval
    const item = await Item.findById(claim.item);

    if (!item) {
      return res.status(404).json({
        message: 'Item not found'
      });
    }

    if (item.status === 'resolved') {
      return res.status(400).json({
        message: 'This item has already been resolved.'
      });
    }

    if (status === 'Approved') {

      // Approve selected claim
      claim.status = 'Locked';
      await claim.save();

      // Resolve item
      await Item.findByIdAndUpdate(claim.item, {
        status: 'resolved'
      });

      // Reject all other pending claims
      await Claim.updateMany(
        {
          item: claim.item,
          _id: { $ne: claim._id },
          status: 'Pending'
        },
        {
          status: 'Rejected'
        }
      );

      return res.status(200).json({
        message: 'Claim approved and locked successfully. Item marked as resolved.',
        claim
      });
    }

    // Reject selected claim
    claim.status = 'Rejected';
    await claim.save();

    res.status(200).json({
      message: 'Claim rejected successfully',
      claim
    });

  } catch (err) {
    console.error('[Update Claim Error]:', err);

    res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
});

module.exports = router;
