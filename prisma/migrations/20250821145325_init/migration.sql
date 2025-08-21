-- CreateEnum
CREATE TYPE "public"."StoreState" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "public"."ReportStatus" AS ENUM ('RUNNING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "public"."StoreStatus" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "timestampUtc" TIMESTAMP(3) NOT NULL,
    "status" "public"."StoreState" NOT NULL,

    CONSTRAINT "StoreStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BusinessHours" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "BusinessHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StoreTimezone" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,

    CONSTRAINT "StoreTimezone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Report" (
    "id" TEXT NOT NULL,
    "status" "public"."ReportStatus" NOT NULL DEFAULT 'RUNNING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "filePath" TEXT NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreStatus_storeId_idx" ON "public"."StoreStatus"("storeId");

-- CreateIndex
CREATE INDEX "BusinessHours_storeId_idx" ON "public"."BusinessHours"("storeId");

-- CreateIndex
CREATE INDEX "StoreTimezone_storeId_idx" ON "public"."StoreTimezone"("storeId");
