const nodemailer = require('nodemailer');

const sendEmail = async (to, subject, html) => {
    try {
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
            // --- ADD THIS LINE ---
            family: 4, // Forces the connection to use IPv4
            // ---------------------
            connectionTimeout: 10000,
            socketTimeout: 10000,
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
        console.error('❌ SMTP Error Detail:', error.message);
        console.error('❌ SMTP Error Code:', error.code);
        throw error; 
    }
};

module.exports = { sendEmail };