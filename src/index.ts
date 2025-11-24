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
  const errors: string[] = [];

  if (typeof gigInput.artist !== 'string' || gigInput.artist.trim() === '') {
    errors.push('artist must be a non-empty string');
  }

  if (typeof gigInput.venue !== 'string' || gigInput.venue.trim() === '') {
    errors.push('venue must be a non-empty string');
  }

  if (typeof gigInput.city !== 'string' || gigInput.city.trim() === '') {
    errors.push('city must be a non-empty string');
  }

  if (typeof gigInput.date !== 'string' || gigInput.date.trim() === '') {
    errors.push('date must be a non-empty string');
  } else {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(gigInput.date.trim())) {
      errors.push('date must be in YYYY-MM-DD format');
    } else {
      const dateStr = gigInput.date.trim();
      const parsedDate = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(parsedDate.getTime())) {
        errors.push('date must be a valid date');
      } else {
        const [inputYear, inputMonth, inputDay] = dateStr.split('-').map(Number);
        const actualYear = parsedDate.getUTCFullYear();
        const actualMonth = parsedDate.getUTCMonth() + 1;
        const actualDay = parsedDate.getUTCDate();
        
        if (inputYear !== actualYear || inputMonth !== actualMonth || inputDay !== actualDay) {
          errors.push('date must be a valid calendar date');
        }
      }
    }
  }

  if (gigInput.rating !== undefined && gigInput.rating !== null) {
    if (typeof gigInput.rating !== 'number' || !Number.isFinite(gigInput.rating) || gigInput.rating < 1 || gigInput.rating > 5) {
      errors.push('rating must be a number between 1 and 5');
    }
  }

  if (gigInput.notes !== undefined && gigInput.notes !== null && typeof gigInput.notes !== 'string') {
    errors.push('notes must be a string');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors
    });
  }

  const newGig: Gig = {
    id: String(gigs.length + 1),
    artist: gigInput.artist.trim(),
    venue: gigInput.venue.trim(),
    city: gigInput.city.trim(),
    date: gigInput.date.trim(),
    rating: gigInput.rating,
    notes: gigInput.notes ? gigInput.notes.trim() : undefined
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
