const express = require('express');
const router = express.Router();
const Item = require('../models/Item');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../config/cloudinary');

const handleUpload = (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error("Cloudinary Upload Error:", err);
      return res.status(400).json({ message: "Image upload failed: " + (err.message || "Invalid Image") });
    }
    next();
  });
};

// Get All Items
router.get('/', async (req, res) => {
  try {
    const { type, category, search, status } = req.query;
    let query = {};

    if (type) query.type = type;
    if (category) query.category = category;
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } }
      ];
    }

    const items = await Item.find(query)
      .populate('user', 'name email phone')
      .sort({ createdAt: -1 });

    res.status(200).json(items);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get My Posts
router.get('/my-posts', protect, async (req, res) => {
  try {
    const myItems = await Item.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json(myItems);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get Single Item
router.get('/:id', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id).populate('user', 'name email phone');
    if (!item) return res.status(404).json({ message: 'Item not found' });
    res.status(200).json(item);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Create Item
router.post('/', protect, handleUpload, async (req, res) => {
  try {
    const { title, description, category, type, location, contactInfo, imageUrl, date } = req.body;

    if (!title || !description || !category || !type || !location || !contactInfo) {
      return res.status(400).json({ message: 'Please fill all required fields' });
    }

    const finalImageUrl = req.file ? req.file.path : (imageUrl || '');

    const newItem = await Item.create({
      title,
      description,
      category,
      type,
      location,
      contactInfo,
      date: date || new Date(),
      imageUrl: finalImageUrl,
      user: req.user._id
    });

    const populatedItem = await Item.findById(newItem._id).populate('user', 'name email phone');

    res.status(201).json(populatedItem);
  } catch (err) {
    console.error("CREATE ITEM DB ERROR:", err);
    res.status(500).json({ message: 'Failed to create item', error: err.message });
  }
});

// Update Item
router.put('/:id', protect, handleUpload, async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });

    if (item.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'User not authorized to update this item' });
    }

    let updateData = { ...req.body };
    if (req.file) {
      updateData.imageUrl = req.file.path;
    }

    const updatedItem = await Item.findByIdAndUpdate(
      req.params.id, 
      updateData, 
      { new: true, runValidators: true }
    ).populate('user', 'name email phone');

    res.status(200).json(updatedItem);
  } catch (err) {
    res.status(400).json({ message: 'Failed to update item', error: err.message });
  }
});

// Delete Item
router.delete('/:id', protect, async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });

    if (item.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'User not authorized to delete this item' });
    }

    await item.deleteOne();
    res.status(200).json({ message: 'Item deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete item', error: err.message });
  }
});

module.exports = router;