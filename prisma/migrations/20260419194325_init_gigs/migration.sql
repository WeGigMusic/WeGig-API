-- CreateTable
CREATE TABLE "Gig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "artistMbid" TEXT,
    "venue" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "rating" INTEGER,
    "notes" TEXT,
    "externalSource" TEXT,
    "externalId" TEXT,
    "ticketUrl" TEXT,
    "venueLatitude" DOUBLE PRECISION,
    "venueLongitude" DOUBLE PRECISION,
    "venuePlaceName" TEXT,
    "venuePlaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Gig_userId_idx" ON "Gig"("userId");

-- CreateIndex
CREATE INDEX "Gig_userId_date_idx" ON "Gig"("userId", "date");

-- CreateIndex
CREATE INDEX "Gig_userId_artist_date_idx" ON "Gig"("userId", "artist", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Gig_userId_externalSource_externalId_key" ON "Gig"("userId", "externalSource", "externalId");
