import express, { Request, Response } from 'express';
import cors from 'cors';
import { Gig, CreateGigInput } from './types/Gig';
import { gigs } from './data/gigsData';

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

app.set('etag', false);
app.use((req: Request, res: Response, next: any) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    message: 'WeGig API is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/gigs', (req: Request, res: Response) => {
  res.json({
    count: gigs.length,
    gigs: gigs
  });
});

app.post('/gigs', (req: Request, res: Response) => {
  const gigInput: CreateGigInput = req.body;

  if (!gigInput.artist || !gigInput.venue || !gigInput.city || !gigInput.date) {
    return res.status(400).json({
      error: 'Missing required fields: artist, venue, city, and date are required'
    });
  }

  const newGig: Gig = {
    id: String(gigs.length + 1),
    artist: gigInput.artist,
    venue: gigInput.venue,
    city: gigInput.city,
    date: gigInput.date,
    rating: gigInput.rating,
    notes: gigInput.notes
  };

  gigs.push(newGig);

  res.status(201).json({
    message: 'Gig added successfully',
    gig: newGig
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WeGig API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Gigs endpoint: http://localhost:${PORT}/gigs`);
});
