const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

exports.uploadMedia = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file provided" });

        const isAudio = req.file.mimetype.startsWith('audio');
        const resourceType = isAudio ? 'video' : 'image';
        const fileBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: `twofold_${resourceType}s`,
            resource_type: resourceType,
            ...(resourceType === 'image' && { 
                transformation: [{ width: 500, height: 500, crop: "fill", gravity: "face" }] 
            })
        });

        res.json({ url: result.secure_url, type: resourceType });
    } catch (err) {
        res.status(500).json({ error: "Upload failed" });
    }
};