# WeGig API

A REST API for tracking concerts and gigs you've attended.

## About

WeGig helps you keep a personal log of all the live music events you've been to. Record the artist, venue, location, date, your rating, and notes about each show.

## Getting Started

### Installation

```bash
npm install
```

### Running the Server

```bash
npm start
```

The API will start on port 5000 at `http://localhost:5000`

## API Endpoints

### Health Check

**GET** `/health`

Returns the API status.

**Response:**
```json
{
  "status": "ok",
  "message": "WeGig API is running",
  "timestamp": "2024-11-24T14:00:00.000Z"
}
```

### Get All Gigs

**GET** `/gigs`

Returns a list of all recorded gigs.

**Response:**
```json
{
  "count": 2,
  "gigs": [
    {
      "id": "1",
      "artist": "The National",
      "venue": "Radio City Music Hall",
      "city": "New York",
      "date": "2024-05-15",
      "rating": 5,
      "notes": "Amazing setlist, played all the classics"
    }
  ]
}
```

### Add a New Gig

**POST** `/gigs`

Adds a new gig to your collection.

**Request Body:**
```json
{
  "artist": "The National",
  "venue": "Radio City Music Hall",
  "city": "New York",
  "date": "2024-05-15",
  "rating": 5,
  "notes": "Amazing setlist, played all the classics"
}
```

**Required Fields:**
- `artist` (string) - The performing artist or band name
- `venue` (string) - The venue name
- `city` (string) - The city where the gig took place
- `date` (string) - Date in YYYY-MM-DD format

**Optional Fields:**
- `rating` (number) - Your rating from 1 to 5
- `notes` (string) - Your personal notes about the gig

**Validation Rules:**
- All required fields must be non-empty strings
- Date must be in YYYY-MM-DD format and a valid calendar date
- Rating must be a number between 1 and 5 (if provided)
- All string fields are automatically trimmed

**Success Response (201):**
```json
{
  "message": "Gig added successfully",
  "gig": {
    "id": "3",
    "artist": "The National",
    "venue": "Radio City Music Hall",
    "city": "New York",
    "date": "2024-05-15",
    "rating": 5,
    "notes": "Amazing setlist, played all the classics"
  }
}
```

**Error Response (400):**
```json
{
  "error": "Validation failed",
  "details": [
    "artist must be a non-empty string",
    "date must be in YYYY-MM-DD format"
  ]
}
```

## Technology Stack

- **Node.js** - JavaScript runtime
- **Express** - Web framework
- **TypeScript** - Type-safe JavaScript
- **CORS** - Cross-origin resource sharing support

## Data Storage

Currently uses in-memory storage with sample data. Data is reset when the server restarts. Future versions may include persistent database storage.

## Development

The server uses `ts-node-dev` for automatic reloading during development. Any changes to TypeScript files will automatically restart the server.
