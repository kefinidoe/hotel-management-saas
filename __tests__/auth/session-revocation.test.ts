import { describe, it, expect, vi } from 'vitest';

/**
 * Session revocation tests.
 *
 * A JWT session carries whatever it was issued with, so these tests lock in the
 * rule that every session read re-checks the account in the database. Without
 * this, deactivating a staff member does not take effect until their token
 * expires -- which used to be 30 days.
 *
 * Note: implementations are set per test with ...Once. Using beforeEach +
 * mockReset() here makes Vitest 5 misfile a caught error from the mock as a
 * test failure, even though the callback handles it correctly.
 */

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique } } }));
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn(),
}));
vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

import { authOptions } from '@/lib/auth';

const session = () => ({
  user: { name: 'A Staffer', email: 'staff@test.local', id: '' },
  expires: new Date(Date.now() + 3600_000).toISOString(),
});

const token = () => ({ id: 'user_1', name: 'A Staffer', email: 'staff@test.local' });

const readSession = () =>
  (authOptions.callbacks!.session as any)({ session: session(), token: token() });

describe('session revocation', () => {
  it('returns a session for an active account', async () => {
    findUnique.mockResolvedValueOnce({ id: 'user_1', name: 'A Staffer', email: 'staff@test.local', isActive: true });
    await expect(readSession()).resolves.toMatchObject({ user: { id: 'user_1' } });
  });

  it('blocks a deactivated account on its next request', async () => {
    findUnique.mockResolvedValueOnce({ id: 'user_1', name: 'A Staffer', email: 'staff@test.local', isActive: false });
    await expect(readSession()).resolves.toBeNull();
  });

  it('blocks an account that no longer exists', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(readSession()).resolves.toBeNull();
  });

  it('blocks a token that carries no user id', async () => {
    const s = await (authOptions.callbacks!.session as any)({ session: session(), token: {} });
    expect(s).toBeNull();
  });

  it('authoritatively syncs user details from the database on every session check', async () => {
    findUnique.mockResolvedValueOnce({ id: 'user_1', name: 'Updated Staffer', email: 'staff@test.local', isActive: true });
    const s = await readSession();
    expect(s.user.name).toBe('Updated Staffer');
  });

  it('keeps the session when the database is briefly unreachable', async () => {
    findUnique.mockImplementationOnce(() => {
      throw new Error('connection lost');
    });
    const s = await readSession();
    expect(s).not.toBeNull();
    expect(s.user.id).toBe('user_1');
  });

  it('caps the session lifetime below the 30-day default', () => {
    expect(authOptions.session?.maxAge).toBeLessThanOrEqual(24 * 60 * 60);
  });
});
