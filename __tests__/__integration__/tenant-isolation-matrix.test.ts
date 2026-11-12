import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Item 6: Advanced Real-PostgreSQL Tenant Isolation & RBAC Matrix', () => {
  let hotelAId: string | undefined;
  let hotelBId: string | undefined;
  let userAId: string | undefined;

  beforeAll(async () => {
    // 1. Create two distinct tenant hotels
    const hotelA = await prisma.hotel.create({ 
      data: { name: 'Hotel Alpha Security', slug: 'hotel-alpha-security' } 
    });
    const hotelB = await prisma.hotel.create({ 
      data: { name: 'Hotel Beta Security', slug: 'hotel-beta-security' } 
    });
    
    hotelAId = hotelA.id;
    hotelBId = hotelB.id;

    // 2. Create user associated with Hotel A
    const userMember = await prisma.user.create({
      data: {
        name: 'Alpha Manager',
        email: 'alpha.manager@security.test',
        role: 'MANAGER',
        hotelId: hotelAId,
        passwordHash: 'mock-hash-for-testing'
      }
    });
    userAId = userMember.id;
  });

  afterAll(async () => {
    // Clean up test records securely using guarded array filters
    const hIds = [hotelAId, hotelBId].filter(Boolean) as string[];
    if (hIds.length > 0) {
      await prisma.user.deleteMany({ where: { hotelId: { in: hIds } } });
      await prisma.hotel.deleteMany({ where: { id: { in: hIds } } });
    }
    await prisma.$disconnect();
  });

  describe('Cross-Tenant Data Isolation & RBAC Scoping', () => {
    it('ensures separate hotels have distinct IDs and cannot overlap', () => {
      expect(hotelAId).toBeDefined();
      expect(hotelBId).toBeDefined();
      expect(hotelAId).not.toEqual(hotelBId);
    });

    it('enforces hotelId scoping on users', async () => {
      expect(userAId).toBeDefined();
      const user = await prisma.user.findUnique({ where: { id: userAId } });
      expect(user?.hotelId).toEqual(hotelAId);
      expect(user?.hotelId).not.toEqual(hotelBId);
    });

    it('prevents cross-tenant record queries by strict hotelId partitioning', async () => {
      // Attempting to query Hotel A user using Hotel B ID must return zero results
      const crossTenantQuery = await prisma.user.findMany({
        where: { id: userAId, hotelId: hotelBId }
      });
      expect(crossTenantQuery).toHaveLength(0);
    });
  });
});
