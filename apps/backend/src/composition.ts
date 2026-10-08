/**
 * Application composition root — mirrors module/composition.py.
 */
import { AuthenticationService } from './application/auth';
import { db } from './database/facade';

export const authService = new AuthenticationService(() => db);
