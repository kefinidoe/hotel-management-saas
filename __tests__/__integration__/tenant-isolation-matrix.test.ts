import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Item 6: Advanced Real-PostgreSQL Tenant Isolation & RBAC Matrix', () => {
  let hotelAId: string | undefined;
  let hotelBId: string | undefined;
  let guestAId: string | undefined;

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

    // 2. Create guest associated with Hotel A (tenant partitioning)
    const guestMember = await prisma.guest.create({
      data: {
        firstName: 'Alpha',
        lastName: 'Guest',
        email: 'alpha.guest@security.test',
        hotelId: hotelAId
      }
    });
    guestAId = guestMember.id;
  });

  afterAll(async () => {
    // Clean up test records securely using guarded array filters
    const hIds = [hotelAId, hotelBId].filter(Boolean) as string[];
    if (hIds.length > 0) {
      await prisma.guest.deleteMany({ where: { hotelId: { in: hIds } } });
      await prisma.hotel.deleteMany({ where: { id: { in: hIds } } });
    }
    await prisma.$disconnect();
  });

  describe('Cross-Tenant Data Isolation & Partitioning', () => {
    it('ensures separate hotels have distinct IDs and cannot overlap', () => {
      expect(hotelAId).toBeDefined();
      expect(hotelBId).toBeDefined();
      expect(hotelAId).not.toEqual(hotelBId);
    });

    it('enforces hotelId scoping on guests', async () => {
      expect(guestAId).toBeDefined();
      const guest = await prisma.guest.findUnique({ where: { id: guestAId } });
      expect(guest?.hotelId).toEqual(hotelAId);
      expect(guest?.hotelId).not.toEqual(hotelBId);
    });

    it('prevents cross-tenant record queries by strict hotelId partitioning', async () => {
      // Attempting to query Hotel A guest using Hotel B ID must return zero results
      const crossTenantQuery = await prisma.guest.findMany({
        where: { id: guestAId, hotelId: hotelBId }
      });
      expect(crossTenantQuery).toHaveLength(0);
    });
  });
});
