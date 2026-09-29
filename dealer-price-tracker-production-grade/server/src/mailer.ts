import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";
import type { Config } from "./config";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Plain-text email (customer-typed content never becomes HTML). Without SMTP settings it only logs. */
export function createMailer(config: Config, log: FastifyBaseLogger): Mailer {
  const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;
  return {
    async send(to, subject, text) {
      if (!transport) {
        log.info({ subject }, "email not sent (SMTP not configured)");
        return;
      }
      try {
        await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
      } catch (err) {
        log.error({ err, subject }, "email failed");
      }
    },
  };
}
