const nodemailer = require('nodemailer');

const sendEmail = async (to, subject, html) => {
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail', // You can use 'gmail', 'SendGrid', 'Resend', etc.
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS, // Use an "App Password" if using Gmail
            },
        });

        const mailOptions = {
            from: `"TwoFold App" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html,
        };

        await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent to ${to}`);
    } catch (error) {
        console.error('❌ Email failed:', error);
        throw new Error('Email could not be sent');
    }
};

module.exports = { sendEmail };