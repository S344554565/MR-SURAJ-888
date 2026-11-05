require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'change-this-secret-in-production',
  JWT_EXPIRES: '7d',
  OWNER: 'MR SURAJ',
  APP_NAME: 'SURAJ MESSENGER'
};
