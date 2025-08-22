/*
  Warnings:

  - A unique constraint covering the columns `[storeId]` on the table `StoreTimezone` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "StoreTimezone_storeId_key" ON "public"."StoreTimezone"("storeId");
