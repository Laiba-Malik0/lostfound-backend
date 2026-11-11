const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");

const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "lost_and_found_items",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "avif"],
    resource_type: "image",
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      const error = new Error("Only JPG, PNG, WEBP and AVIF images are allowed.");
      error.code = "INVALID_IMAGE_TYPE";
      return callback(error);
    }

    return callback(null, true);
  },
});

upload.isConfigured = cloudinaryConfigured;

module.exports = upload;
