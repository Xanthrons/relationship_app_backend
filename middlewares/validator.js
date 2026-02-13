const Joi = require('joi');

const validateForgotPassword = (data) => {
    const schema = Joi.object({
        email: Joi.string().email().required().messages({
            'string.email': 'Please provide a valid email address',
            'any.required': 'Email is required',
        }),
    });
    return schema.validate(data);
};

const validateResetPassword = (data) => {
    const schema = Joi.object({
        email: Joi.string().email().required(),
        code: Joi.string().length(6).required().messages({
            'string.length': 'Verification code must be 6 digits',
        }),
        newPassword: Joi.string().min(8).required().messages({
            'string.min': 'Password must be at least 8 characters long',
        }),
    });
    return schema.validate(data);
};

module.exports = { 
    validateForgotPassword, 
    validateResetPassword 
};