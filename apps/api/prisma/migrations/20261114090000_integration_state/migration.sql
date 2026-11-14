-- What is known about whether each data source of an organisation is working.
-- Additive: no existing table or column changes.
CREATE TABLE "IntegrationState" (
    "organizationId" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "unknownServices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "lastCheckDetail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationState_pkey" PRIMARY KEY ("organizationId","integration")
);

ALTER TABLE "IntegrationState" ADD CONSTRAINT "IntegrationState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
