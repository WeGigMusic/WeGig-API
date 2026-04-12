export interface Gig {
  id: string;
  artist: string;
  artistMbid?: string;
  venue: string;
  city: string;
  date: string;
  rating?: number;
  notes?: string;

  externalSource?: string;
  externalId?: string;
  ticketUrl?: string;

  venueLatitude?: number;
  venueLongitude?: number;
  venuePlaceName?: string;
  venuePlaceId?: string;
}

export interface CreateGigInput {
  artist: string;
  artistMbid?: string;
  venue: string;
  city: string;
  date: string;
  rating?: number;
  notes?: string;

  externalSource?: string;
  externalId?: string;
  ticketUrl?: string;

  venueLatitude?: number;
  venueLongitude?: number;
  venuePlaceName?: string;
  venuePlaceId?: string;
}