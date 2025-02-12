import * as argon2 from 'argon2';
import validator from 'validator';
import { TotpAuthenticator } from '@/server/utils/totp';
import { AuthQueries } from '@/server/queries/auth/auth.queries';
import { Context } from '@/server/context';
import { TranslatedError } from '@/server/utils/errors';
import { Locales, getLocaleFromString } from '@/shared/internationalization/locales';
import { generateSessionId } from '@/server/common/session.helpers';
import { Database } from '@/server/db';
import { getConfig } from '../../core/TipiConfig';
import TipiCache from '../../core/TipiCache';
import { fileExists, unlinkFile } from '../../common/fs.helpers';
import { decrypt, encrypt } from '../../utils/encryption';

type UsernamePasswordInput = {
  username: string;
  password: string;
  locale?: string;
};

export class AuthServiceClass {
  private queries;

  constructor(p: Database) {
    this.queries = new AuthQueries(p);
  }

  /**
   * Authenticate user with given username and password
   *
   * @param {UsernamePasswordInput} input - An object containing the user's username and password
   * @param {Request} req - The Next.js request object
   */
  public login = async (input: UsernamePasswordInput, req: Context['req']) => {
    const { password, username } = input;
    const user = await this.queries.getUserByUsername(username);

    if (!user) {
      throw new TranslatedError('server-messages.errors.user-not-found');
    }

    const isPasswordValid = await argon2.verify(user.password, password);

    if (!isPasswordValid) {
      throw new TranslatedError('server-messages.errors.invalid-credentials');
    }

    if (user.totpEnabled) {
      const totpSessionId = generateSessionId('otp');
      await TipiCache.set(totpSessionId, user.id.toString());
      return { totpSessionId };
    }

    req.session.userId = user.id;
    await TipiCache.set(`session:${user.id}:${req.session.id}`, req.session.id);

    return {};
  };

  /**
   * Verify TOTP code and return a JWT token
   *
   * @param {object} params - An object containing the TOTP session ID and the TOTP code
   * @param {string} params.totpSessionId - The TOTP session ID
   * @param {string} params.totpCode - The TOTP code
   * @param {Request} req - The Next.js request object
   */
  public verifyTotp = async (params: { totpSessionId: string; totpCode: string }, req: Context['req']) => {
    const { totpSessionId, totpCode } = params;
    const userId = await TipiCache.get(totpSessionId);

    if (!userId) {
      throw new TranslatedError('server-messages.errors.totp-session-not-found');
    }

    const user = await this.queries.getUserById(Number(userId));

    if (!user) {
      throw new TranslatedError('server-messages.errors.user-not-found');
    }

    if (!user.totpEnabled || !user.totpSecret || !user.salt) {
      throw new TranslatedError('server-messages.errors.totp-not-enabled');
    }

    const totpSecret = decrypt(user.totpSecret, user.salt);
    const isValid = TotpAuthenticator.check(totpCode, totpSecret);

    if (!isValid) {
      throw new TranslatedError('server-messages.errors.totp-invalid-code');
    }

    req.session.userId = user.id;

    return true;
  };

  /**
   * Given a userId returns the TOTP URI and the secret key
   *
   * @param {object} params - An object containing the userId and the user's password
   * @param {number} params.userId - The user's ID
   * @param {string} params.password - The user's password
   */
  public getTotpUri = async (params: { userId: number; password: string }) => {
    if (getConfig().demoMode) {
      throw new TranslatedError('server-messages.errors.not-allowed-in-demo');
    }

    const { userId, password } = params;

    const user = await this.queries.getUserById(userId);

    if (!user) {
      throw new TranslatedError('server-messages.errors.user-not-found');
    }

    const isPasswordValid = await argon2.verify(user.password, password);
    if (!isPasswordValid) {
      throw new TranslatedError('server-messages.errors.invalid-password');
    }

    if (user.totpEnabled) {
      throw new TranslatedError('server-messages.errors.totp-already-enabled');
    }

    let { salt } = user;
    const newTotpSecret = TotpAuthenticator.generateSecret();

    if (!salt) {
      salt = generateSessionId('');
    }

    const encryptedTotpSecret = encrypt(newTotpSecret, salt);

    await this.queries.updateUser(userId, { totpSecret: encryptedTotpSecret, salt });

    const uri = TotpAuthenticator.keyuri(user.username, 'Runtipi', newTotpSecret);

    return { uri, key: newTotpSecret };
  };

  public setupTotp = async (params: { userId: number; totpCode: string }) => {
    if (getConfig().demoMode) {
      throw new TranslatedError('server-messages.errors.not-allowed-in-demo');
    }

    const { userId, totpCode } = params;
    const user = await this.queries.getUserById(userId);

    if (!user) {
      throw new TranslatedError('server-messages.errors.user-not-found');
    }

    if (user.totpEnabled || !user.totpSecret || !user.salt) {
      throw new TranslatedError('server-messages.errors.totp-already-enabled');
    }

    const totpSecret = decrypt(user.totpSecret, user.salt);
    const isValid = TotpAuthenticator.check(totpCode, totpSecret);

    if (!isValid) {
      throw new TranslatedError('server-messages.errors.totp-invalid-code');
    }

    await this.queries.updateUser(userId, { totpEnabled: true });

    return true;
  };

  public disableTotp = async (params: { userId: number; password: string }) => {
    const { userId, password } = params;

    const user = await this.queries.getUserById(userId);

    if (!user) {
      throw new TranslatedError('server-messages.errors.user-not-found');
    }

    if (!user.totpEnabled) {
      throw new TranslatedError('server-messages.errors.totp-not-enabled');
    }

    const isPasswordValid = await argon2.verify(user.password, password);
    if (!isPasswordValid) {
      throw new TranslatedError('server-messages.errors.invalid-password');
    }

    await this.queries.updateUser(userId, { totpEnabled: false, totpSecret: null });

    return true;
  };

  /**
   * Creates a new user with the provided email and password and returns a session token
   *
   * @param {UsernamePasswordInput} input - An object containing the email and password fields
   * @param {Request} req - The Next.js request object
   */
  public register = async (input: UsernamePasswordInput, req: Context['req']) => {
    const operators = await this.queries.getOperators();

    if (operators.length > 0) {
      throw new TranslatedError('server-messages.errors.admin-already-exists');
    }

    const { password, username } = input;
    const email = username.trim().toLowerCase();

    if (!username || !password) {
      throw new TranslatedError('server-messages.errors.missing-email-or-password');
    }

    if (username.length < 3 || !validator.isEmail(email)) {
      throw new TranslatedError('server-messages.errors.invalid-username');
    }

    const user = await this.queries.getUserByUsername(email);

    if (user) {
      throw new TranslatedError('server-messages.errors.user-already-exists');
    }

    const hash = await argon2.hash(password);

    const newUser = await this.queries.createUser({ username: email, password: hash, operator: true, locale: getLocaleFromString(input.locale) });

    if (!newUser) {
      throw new TranslatedError('server-messages.errors.error-creating-user');
    }

    req.session.userId = newUser.id;
    await TipiCache.set(`session:${newUser.id}:${req.session.id}`, req.session.id);

    return true;
  };

  /**
   * Retrieves the user with the provided ID
   *
   * @param {number|undefined} userId - The user ID to retrieve
   */
  public me = async (userId: number | undefined) => {
    if (!userId) return null;

    const user = await this.queries.getUserDtoById(userId);

    if (!user) return null;

    return user;
  };

  /**
   * Logs out the current user by removing the session token
   *
   * @param  {Request} req - The Next.js request object
   * @returns {Promise<boolean>} - Returns true if the session token is removed successfully
   */
  public static logout = async (req: Context['req']): Promise<boolean> => {
    if (!req.session) {
      return true;
    }

    req.session.destroy(() => {});

    return true;
  };

  /**
   * Check if the system is configured and has at least one user
   *
   * @returns {Promise<boolean>} - A boolean indicating if the system is configured or not
   */
  public isConfigured = async (): Promise<boolean> => {
    const operators = await this.queries.getOperators();

    return operators.length > 0;
  };

  /**
   * Change the password of the operator user
   *
   * @param {object} params - An object containing the new password
   * @param {string} params.newPassword - The new password
   */
  public changeOperatorPassword = async (params: { newPassword: string }) => {
    if (!AuthServiceClass.checkPasswordChangeRequest()) {
      throw new TranslatedError('server-messages.errors.no-change-password-request');
    }

    const { newPassword } = params;

    const user = await this.queries.getFirstOperator();

    if (!user) {
      throw new TranslatedError('server-messages.errors.operator-not-found');
    }

    const hash = await argon2.hash(newPassword);

    await this.queries.updateUser(user.id, { password: hash, totpEnabled: false, totpSecret: null });

    await unlinkFile(`/runtipi/state/password-change-request`);

    return { email: user.username };
  };

  /*
   * Check if there is a pending password change request for the given email
   * Returns true if there is a file in the password change requests folder with the given email
   *
   * @returns {boolean} - A boolean indicating if there is a password change request or not
   */
  public static checkPasswordChangeRequest = () => {
    if (fileExists(`/runtipi/state/password-change-request`)) {
      return true;
    }

    return false;
  };

  /*
   * If there is a pending password change request, remove it
   * Returns true if the file is removed successfully
   *
   * @returns {boolean} - A boolean indicating if the file is removed successfully or not
   * @throws {Error} - If the file cannot be removed
   */
  public static cancelPasswordChangeRequest = async () => {
    if (fileExists(`/runtipi/state/password-change-request`)) {
      await unlinkFile(`/runtipi/state/password-change-request`);
    }

    return true;
  };

  /**
   * Given a user ID, destroy all sessions for that user
   *
   * @param {number} userId - The user ID
   */
  private destroyAllSessionsByUserId = async (userId: number) => {
    const sessions = await TipiCache.getByPrefix(`session:${userId}:`);

    await Promise.all(
      sessions.map(async (session) => {
        await TipiCache.del(session.key);
        await TipiCache.del(`tipi:${session.val}`);
      }),
    );
  };

  public changePassword = async (params: { currentPassword: string; newPassword: string; userId: number }) => {
    if (getConfig().demoMode) {
      throw new TranslatedError('server-messages.errors.not-allowed-in-demo');
    }

    const { currentPassword, newPassword, userId } = params;

    const user = await this.queries.getUserById(userId);

    if (!user) {
      throw new TranslatedError('server-messages.errors.user-not-found');
    }

    const valid = await argon2.verify(user.password, currentPassword);

    if (!valid) {
      throw new TranslatedError('server-messages.errors.invalid-password');
    }

    if (newPassword.length < 8) {
      throw new TranslatedError('server-messages.errors.invalid-password-length');
    }

    const hash = await argon2.hash(newPassword);
    await this.queries.updateUser(user.id, { password: hash });
    await this.destroyAllSessionsByUserId(user.id);

    return true;
  };

  /**
   * Given a userId and a locale, change the user's locale
   *
   * @param {object} params - An object containing the user ID and the new locale
   * @param {string} params.locale - The new locale
   * @param {number} params.userId - The user ID
   */
  public changeLocale = async (params: { locale: string; userId: number }) => {
    const { locale, userId } = params;

    const isLocaleValid = Locales.includes(locale);

    if (!isLocaleValid) {
      throw new TranslatedError('server-messages.errors.invalid-locale');
    }

    const user = await this.queries.getUserById(userId);

    if (!user) {
      throw new TranslatedError('server-messages.errors.user-not-found');
    }

    await this.queries.updateUser(user.id, { locale });

    return true;
  };
}
