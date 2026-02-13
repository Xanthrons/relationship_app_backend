exports.uploadMedia = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file provided" });

        // Determine if it's audio or image
        const isAudio = req.file.mimetype.startsWith('audio');
        const resourceType = isAudio ? 'video' : 'image'; // Cloudinary treats audio as 'video'

        const fileBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: `twofold_${resourceType}s`,
            resource_type: resourceType,
            // Only apply face-crop if it's an image
            ...(resourceType === 'image' && { 
                transformation: [{ width: 500, height: 500, crop: "fill", gravity: "face" }] 
            })
        });

        res.json({ 
            message: "Upload successful!", 
            url: result.secure_url,
            type: resourceType 
        });
    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: "Failed to upload media" });
    }
};