const nodemailer = require('nodemailer');

const sendEmail = async (to, subject, html) => {
    try {
        const transporter = nodemailer.createTransport({
            // Instead of service: 'gmail', we use the direct host and secure port
            host: 'smtp.gmail.com',
            port: 465, 
            secure: true, // true for 465, false for other ports
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS, // 16-character App Password
            },
            // The following settings help prevent timeouts on cloud hosting
            connectionTimeout: 10000, // 10 seconds
            socketTimeout: 10000,
            greetingTimeout: 10000,
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
        // Detailed logging to help us see exactly why Gmail is mad
        console.error('❌ SMTP Error Detail:', error.message);
        console.error('❌ SMTP Error Code:', error.code);
        
        // Re-throwing so the controller's catch block can catch it
        throw error; 
    }
};

module.exports = { sendEmail };