const nodemailer = require('nodemailer');

const { Resend } = require('resend');

// Initialize with your API key from Render Environment Variables
const resend = new Resend(process.env.RESEND_API_KEY);

const sendEmail = async (to, subject, html) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'TwoFold <onboarding@resend.dev>', // While testing, you must use this 'from' address
      to: [to],
      subject: subject,
      html: html,
    });

    if (error) {
      console.error('❌ Resend Error:', error);
      throw new Error(error.message);
    }

    console.log(`📧 Email sent successfully via Resend: ${data.id}`);
  } catch (err) {
    console.error('❌ Mailer Error:', err.message);
    throw err;
  }
};

module.exports = { sendEmail };