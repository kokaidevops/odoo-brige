// src/utils/logger.js
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${stack || message}${metaStr}`;
});

const transports = [
  new winston.transports.Console({
    format: combine(
      colorize({ all: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }),
      logFormat
    ),
  }),
];

// Add file transports in non-test environments
if (process.env.NODE_ENV !== 'test') {
  const logDir = process.env.LOG_DIR || './logs';

  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '14d',
      zippedArchive: true,
      format: combine(timestamp(), errors({ stack: true }), winston.format.json()),
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(logDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      zippedArchive: true,
      format: combine(timestamp(), errors({ stack: true }), winston.format.json()),
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
  exitOnError: false,
});

module.exports = logger;
