const Item = require('../models/Item');

// 1. Create New Item (Lost or Found)
const createItem = async (req, res) => {
  try {
    const { title, description, category, type, location, contactInfo, imageUrl, date } = req.body;

    if (!title || !description || !category || !type || !location || !contactInfo) {
      return res.status(400).json({ message: 'Please fill all required fields' });
    }

    // Cloudinary file path or fallback to URL string
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
      user: req.user.id
    });

    res.status(201).json(newItem);
  } catch (err) {
    console.error("Create Item Error:", err);
    res.status(500).json({ message: 'Failed to create item', error: err.message });
  }
};

// 2. Get All Items
const getItems = async (req, res) => {
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
};

// 3. Get My Posts
const getMyPosts = async (req, res) => {
  try {
    const myItems = await Item.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.status(200).json(myItems);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// 4. Get Single Item
const getItemById = async (req, res) => {
  try {
    const item = await Item.findById(req.params.id).populate('user', 'name email phone');
    if (!item) return res.status(404).json({ message: 'Item not found' });
    res.status(200).json(item);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// 5. Update Item
const updateItem = async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });

    if (item.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'User not authorized to update this item' });
    }

    let updateData = { ...req.body };
    if (req.file) {
      updateData.imageUrl = req.file.path;
    }

    const updatedItem = await Item.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    res.status(200).json(updatedItem);
  } catch (err) {
    res.status(400).json({ message: 'Failed to update item', error: err.message });
  }
};

// 6. Delete Item
const deleteItem = async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });

    if (item.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'User not authorized to delete this item' });
    }

    await item.deleteOne();
    res.status(200).json({ message: 'Item deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete item', error: err.message });
  }
};

module.exports = {
  createItem,
  getItems,
  getMyPosts,
  getItemById,
  updateItem,
  deleteItem
};