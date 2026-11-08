import { HttpError, isTaken, takenError } from './errors.js';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED = new Set(['admin', 'support', 'billing', 'stripe', 'bracket', 'root', 'null']);

export function normalizeUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function checkUsername(raw) {
  const name = normalizeUsername(raw);
  if (!name) throw new HttpError(400, 'MISSING_USERNAME');
  if (!USERNAME_RE.test(name) || RESERVED.has(name)) throw new HttpError(400, 'INVALID_USERNAME');
  return name;
}

export function checkEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) throw new HttpError(400, 'MISSING_EMAIL');
  if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'INVALID_EMAIL');
  return email;
}

export function checkPassword(raw) {
  const password = String(raw || '');
  if (!password) throw new HttpError(400, 'MISSING_PASSWORD');
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'SHORT_PASSWORD');
  return password;
}

function identityBase(config) {
  if (config.authEmulator) return 'http://' + config.authEmulator;
  return 'https://identitytoolkit.googleapis.com';
}

function tokenBase(config) {
  if (config.authEmulator) return 'http://' + config.authEmulator + '/securetoken.googleapis.com/v1/';
  return 'https://securetoken.googleapis.com/v1/';
}

async function postJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  return { ok: res.ok, status: res.status, json };
}

export function createAccounts(deps) {
  const { auth, db, config, fetch: fetchImpl, now } = deps;
  const clock = now || (() => Date.now());

  function identityUrl(method) {
    const host = identityBase(config);
    const prefix = config.authEmulator ? host + '/identitytoolkit.googleapis.com/v1/' : host + '/v1/';
    return prefix + method + '?key=' + encodeURIComponent(config.webApiKey);
  }

  async function passwordSignIn(email, password) {
    const result = await postJson(fetchImpl, identityUrl('accounts:signInWithPassword'), {
      email, password, returnSecureToken: true
    });
    if (!result.ok) {
      const err = new HttpError(401, 'INVALID_LOGIN');
      err.authCode = String(result.json?.error?.message || '').split(/[\s:]/)[0];
      throw err;
    }
    return result.json;
  }

  async function sendReset(email) {
    const result = await postJson(fetchImpl, identityUrl('accounts:sendOobCode'), {
      requestType: 'PASSWORD_RESET',
      email
    });
    if (!result.ok) {
      const code = String(result.json?.error?.message || '').split(/[\s:]/)[0];
      if (code === 'EMAIL_NOT_FOUND') return;
      throw new HttpError(502, 'SERVER');
    }
  }

  function publicSession(tokens, username) {
    return {
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      expiresIn: String(tokens.expiresIn || '3600'),
      localId: tokens.localId,
      email: tokens.email,
      username: username || null
    };
  }

  async function reserve(name) {
    const ref = db.collection('usernames').doc(name);
    const reservation = crypto.randomUUID();
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : null;
        if (data && data.uid) throw takenError();
        if (data && data.pending && data.reservation !== reservation && clock() - (data.reservedAt || 0) < 120000) {
          throw takenError();
        }
        tx.set(ref, { pending: true, reservation, reservedAt: clock() });
      });
    } catch (err) {
      if (isTaken(err)) throw new HttpError(409, 'USERNAME_TAKEN');
      throw err;
    }
    return { ref, reservation };
  }

  async function release(ref, reservation) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.data().reservation === reservation && !snap.data().uid) tx.delete(ref);
    });
  }

  async function claim(ref, reservation, uid) {
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().reservation !== reservation || (snap.data().uid && snap.data().uid !== uid)) {
          throw takenError();
        }
        tx.set(ref, { uid, createdAt: clock() });
      });
    } catch (err) {
      if (isTaken(err)) throw new HttpError(409, 'USERNAME_TAKEN');
      throw err;
    }
  }

  return {
    passwordSignIn,
    tokenBase,
    async register({ username, email, password }) {
      const name = checkUsername(username);
      const addr = checkEmail(email);
      const pass = checkPassword(password);
      const { ref, reservation } = await reserve(name);
      let user;
      try {
        user = await auth.createUser({ email: addr, password: pass, displayName: name });
      } catch (err) {
        await release(ref, reservation);
        if (err && err.code === 'auth/email-already-exists') throw new HttpError(409, 'EMAIL_EXISTS');
        if (err && err.code === 'auth/invalid-password') throw new HttpError(400, 'SHORT_PASSWORD');
        if (err && err.code === 'auth/invalid-email') throw new HttpError(400, 'INVALID_EMAIL');
        throw new HttpError(502, 'SERVER');
      }
      try {
        await claim(ref, reservation, user.uid);
        await db.collection('profiles').doc(user.uid).set({ username: name, createdAt: clock() });
      } catch (err) {
        await auth.deleteUser(user.uid).catch(() => {});
        await release(ref, reservation);
        throw err;
      }
      const tokens = await passwordSignIn(addr, pass);
      return publicSession(tokens, name);
    },

    async login({ username, password }) {
      const name = checkUsername(username);
      checkPassword(password);
      const snap = await db.collection('usernames').doc(name).get();
      const uid = snap.exists ? snap.data().uid : null;
      if (!uid) {
        await passwordSignIn('no-such-user@example.invalid', password).catch(() => {});
        throw new HttpError(401, 'INVALID_LOGIN');
      }
      const user = await auth.getUser(uid);
      try {
        const tokens = await passwordSignIn(user.email, password);
        return publicSession(tokens, name);
      } catch {
        throw new HttpError(401, 'INVALID_LOGIN');
      }
    },

    async reset({ username, email }) {
      if (username && email) throw new HttpError(400, 'INVALID_JSON');
      let addr = null;
      if (username) {
        const name = checkUsername(username);
        const snap = await db.collection('usernames').doc(name).get();
        if (snap.exists && snap.data().uid) {
          const user = await auth.getUser(snap.data().uid);
          addr = user.email || null;
        }
      } else if (email) {
        addr = checkEmail(email);
      } else {
        throw new HttpError(400, 'MISSING_EMAIL');
      }
      if (addr) await sendReset(addr).catch(() => {});
      return { ok: true };
    },

    async logout(uid) {
      await auth.revokeRefreshTokens(uid);
      return { ok: true };
    },

    async removeAccount(uid, password, stripe) {
      checkPassword(password);
      const user = await auth.getUser(uid);
      try {
        await passwordSignIn(user.email, password);
      } catch {
        throw new HttpError(401, 'WRONG_PASSWORD');
      }
      const billing = await db.collection('billing').doc(uid).get();
      const subId = billing.exists ? billing.data().subscriptionId : null;
      if (subId && stripe && stripe.subscriptions && stripe.subscriptions.update) {
        await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      }
      const profile = await db.collection('profiles').doc(uid).get();
      if (profile.exists && profile.data().username) {
        const ref = db.collection('usernames').doc(profile.data().username);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists && snap.data().uid === uid) tx.delete(ref);
        });
      }
      await db.collection('profiles').doc(uid).delete().catch(() => {});
      await db.collection('users').doc(uid).delete().catch(() => {});
      await auth.deleteUser(uid);
      return { ok: true };
    }
  };
}

export { tokenBase };
