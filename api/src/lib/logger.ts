import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const hasLogtailToken = Boolean(process.env.LOGTAIL_TOKEN);

const transport =
  isProduction && hasLogtailToken
    ? pino.transport({
        target: '@logtail/pino',
        options: { sourceToken: process.env.LOGTAIL_TOKEN },
      })
    : pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      });

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    ...(!isProduction
      ? {}
      : {
          formatters: {
            level: (label: string) => ({ level: label }),
          },
        }),
  },
  transport,
);

export default logger;
