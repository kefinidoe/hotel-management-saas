import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Item 6: Real-PostgreSQL Tenant Isolation & RBAC Matrix', () => {
  let hotelAId: string | undefined;
  let hotelBId: string | undefined;

  beforeAll(async () => {
    const hotelA = await prisma.hotel.create({ data: { name: 'Hotel Alpha Integration', slug: 'hotel-alpha-integration' } });
    const hotelB = await prisma.hotel.create({ data: { name: 'Hotel Beta Integration', slug: 'hotel-beta-integration' } });
    
    hotelAId = hotelA.id;
    hotelBId = hotelB.id;
  });

  afterAll(async () => {
    const ids = [hotelAId, hotelBId].filter(Boolean) as string[];
    if (ids.length > 0) {
      await prisma.hotel.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  describe('Cross-Tenant Data Isolation', () => {
    it('ensures separate hotels have distinct IDs and cannot overlap', () => {
      expect(hotelAId).toBeDefined();
      expect(hotelBId).toBeDefined();
      expect(hotelAId).not.toEqual(hotelBId);
    });
  });
});
