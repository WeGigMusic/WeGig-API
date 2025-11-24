export interface Gig {
  id: string;
  artist: string;
  venue: string;
  city: string;
  date: string;
  rating?: number;
  notes?: string;
}

export interface CreateGigInput {
  artist: string;
  venue: string;
  city: string;
  date: string;
  rating?: number;
  notes?: string;
}
