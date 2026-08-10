const sendMail = jest.fn();
const createTransport = jest.fn((_options?: unknown) => ({ sendMail }));

jest.mock('nodemailer', () => ({
  createTransport: (options: unknown) => createTransport(options)
}));

// The module caches its transporter at first use, and `mailerConfigured()`
// reads env vars at call time -- both need a fresh module + env per test so
// one test's SMTP_HOST doesn't leak into the next.
const loadMailer = () => {
  jest.resetModules();
  return require('../mailer') as typeof import('../mailer');
};

const ORIGINAL_ENV = process.env;

describe('mailer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SMTP_HOST;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const input = {
    to: 'invitee@clustox.com',
    name: 'Invitee Person',
    role: 'ADMIN' as const,
    orgName: 'Acme',
    inviteUrl: 'http://localhost:3333/accept-invite?token=abc',
    expiresAt: new Date('2026-01-01T00:00:00Z')
  };

  it('is not configured without SMTP_HOST', () => {
    const { mailerConfigured } = loadMailer();
    expect(mailerConfigured()).toBe(false);
  });

  it('is configured once SMTP_HOST is set', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    const { mailerConfigured } = loadMailer();
    expect(mailerConfigured()).toBe(true);
  });

  it('skips sending -- without erroring -- when SMTP is not configured', async () => {
    const { sendInviteEmail } = loadMailer();
    const result = await sendInviteEmail(input);
    expect(result).toEqual({ sent: false, error: 'SMTP not configured' });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends via the configured transport and reports success', async () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'batool.fatima@clustox.com';
    process.env.SMTP_FROM = 'Middleware <batool.fatima@clustox.com>';
    sendMail.mockResolvedValueOnce({ messageId: '1' });

    const { sendInviteEmail } = loadMailer();
    const result = await sendInviteEmail(input);

    expect(result).toEqual({ sent: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe(input.to);
    expect(call.from).toBe('Middleware <batool.fatima@clustox.com>');
    expect(call.html).toContain(input.inviteUrl);
    expect(call.text).toContain(input.inviteUrl);
  });

  it('uses implicit TLS only for port 465', async () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '465';
    sendMail.mockResolvedValueOnce({});

    const { sendInviteEmail } = loadMailer();
    await sendInviteEmail(input);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true })
    );
  });

  it('reports failure without throwing when the send rejects', async () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    sendMail.mockRejectedValueOnce(new Error('535 auth failed'));

    const { sendInviteEmail } = loadMailer();
    const result = await sendInviteEmail(input);

    expect(result).toEqual({ sent: false, error: '535 auth failed' });
  });

  it('escapes HTML in the invitee name and workspace name', async () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    sendMail.mockResolvedValueOnce({});

    const { sendInviteEmail } = loadMailer();
    await sendInviteEmail({
      ...input,
      name: '<script>alert(1)</script>',
      orgName: '<b>Acme</b>'
    });

    const html = sendMail.mock.calls[0][0].html as string;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
