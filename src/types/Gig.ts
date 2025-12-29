export interface Gig {
  id: string;
  artist: string;
  venue: string;
  city: string;
  date: string;
  rating?: number;
  notes?: string;

  // ✅ Ticketmaster association (optional)
  externalSource?: string; // e.g. "Ticketmaster"
  externalId?: string; // Ticketmaster event id
}

export interface CreateGigInput {
  artist: string;
  venue: string;
  city: string;
  date: string;
  rating?: number;
  notes?: string;

  // ✅ Ticketmaster association (optional)
  externalSource?: string;
  externalId?: string;
}
