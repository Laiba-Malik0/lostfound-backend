const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const Item = require('../models/Item');
const { protect } = require('../middleware/authMiddleware');
const upload = require('../config/cloudinary');

// Image Upload Handler
const handleUpload = (req, res, next) => {
  if (!upload.isConfigured) {
    return res.status(503).json({
      message: 'Image upload service is not configured on the server.'
    });
  }

  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Cloudinary Upload Error:', err);

      const statusCode =
        err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;

      return res.status(statusCode).json({
        message: err.message || 'Image upload failed'
      });
    }

    next();
  });
};

// GET ALL ITEMS
router.get('/', async (req, res) => {
  try {
    const { type, category, search, status } = req.query;

    const query = {};

    if (type) {
      if (!['lost', 'found'].includes(type)) {
        return res.status(400).json({
          message: 'Invalid item type'
        });
      }

      query.type = type;
    }

    if (category) {
      query.category = category;
    }

    if (status) {
      if (!['open', 'resolved'].includes(status)) {
        return res.status(400).json({
          message: 'Invalid item status'
        });
      }

      query.status = status;
    }

    if (search && String(search).trim()) {
      const safeSearch = String(search).trim().replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      query.$or = [
        { title: { $regex: safeSearch, $options: 'i' } },
        { description: { $regex: safeSearch, $options: 'i' } },
        { location: { $regex: safeSearch, $options: 'i' } }
      ];
    }

    const items = await Item.find(query)
      .populate('user', 'name email phone')
      .sort({ createdAt: -1 });

    return res.status(200).json(items);

  } catch (err) {
    console.error('GET ALL ITEMS ERROR:', err);

    return res.status(500).json({
      message: 'Failed to fetch items',
      error: err.message
    });
  }
});

// GET MY POSTS
router.get('/my-posts', protect, async (req, res) => {
  try {
    const myItems = await Item.find({
      user: req.user._id
    }).sort({ createdAt: -1 });

    return res.status(200).json(myItems);

  } catch (err) {
    console.error('GET MY POSTS ERROR:', err);

    return res.status(500).json({
      message: 'Failed to fetch your posts',
      error: err.message
    });
  }
});

// GET SINGLE ITEM
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: 'Invalid item ID'
      });
    }

    const item = await Item.findById(id)
      .populate('user', 'name email phone');

    if (!item) {
      return res.status(404).json({
        message: 'Item not found'
      });
    }

    return res.status(200).json(item);

  } catch (err) {
    console.error('GET SINGLE ITEM ERROR:', err);

    return res.status(500).json({
      message: 'Failed to fetch item',
      error: err.message
    });
  }
});

// CREATE ITEM
router.post('/', protect, handleUpload, async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      type,
      location,
      contactInfo,
      imageUrl,
      date
    } = req.body;

    if (
      !title ||
      !description ||
      !category ||
      !type ||
      !location ||
      !contactInfo
    ) {
      return res.status(400).json({
        message: 'Please fill all required fields'
      });
    }

    if (!['lost', 'found'].includes(type)) {
      return res.status(400).json({
        message: 'Type must be lost or found'
      });
    }

    const finalImageUrl = req.file
      ? req.file.path
      : (imageUrl || '');

    const newItem = await Item.create({
      title: String(title).trim(),
      description: String(description).trim(),
      category,
      type,
      location: String(location).trim(),
      contactInfo,
      date: date || new Date(),
      imageUrl: finalImageUrl,
      user: req.user._id
    });

    const populatedItem = await Item.findById(newItem._id)
      .populate('user', 'name email phone');

    return res.status(201).json(populatedItem);

  } catch (err) {
    console.error('CREATE ITEM ERROR:', err);

    return res.status(500).json({
      message: 'Failed to create item',
      error: err.message
    });
  }
});

// UPDATE ITEM
router.put('/:id', protect, handleUpload, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: 'Invalid item ID'
      });
    }

    const item = await Item.findById(id);

    if (!item) {
      return res.status(404).json({
        message: 'Item not found'
      });
    }

    if (item.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: 'User not authorized to update this item'
      });
    }

    const allowedFields = [
      'title',
      'description',
      'category',
      'type',
      'location',
      'contactInfo',
      'status',
      'date',
      'imageUrl'
    ];

    const updateData = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    if (req.file) {
      updateData.imageUrl = req.file.path;
    }

    if (
      updateData.type &&
      !['lost', 'found'].includes(updateData.type)
    ) {
      return res.status(400).json({
        message: 'Invalid item type'
      });
    }

    if (
      updateData.status &&
      !['open', 'resolved'].includes(updateData.status)
    ) {
      return res.status(400).json({
        message: 'Invalid item status'
      });
    }

    const updatedItem = await Item.findByIdAndUpdate(
      id,
      updateData,
      {
        new: true,
        runValidators: true
      }
    ).populate('user', 'name email phone');

    return res.status(200).json(updatedItem);

  } catch (err) {
    console.error('UPDATE ITEM ERROR:', err);

    return res.status(500).json({
      message: 'Failed to update item',
      error: err.message
    });
  }
});

// DELETE ITEM
router.delete('/:id', protect, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: 'Invalid item ID'
      });
    }

    const item = await Item.findById(id);

    if (!item) {
      return res.status(404).json({
        message: 'Item not found'
      });
    }

    if (item.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: 'User not authorized to delete this item'
      });
    }

    await item.deleteOne();

    return res.status(200).json({
      success: true,
      message: 'Item deleted successfully'
    });

  } catch (err) {
    console.error('DELETE ITEM ERROR:', err);

    return res.status(500).json({
      message: 'Failed to delete item',
      error: err.message
    });
  }
});

module.exports = router;
