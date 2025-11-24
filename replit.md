# WeGig API

## Overview

WeGig API is a RESTful service for managing concert and live music event records (referred to as "gigs"). The application allows users to track performances they've attended, including details like artist, venue, location, date, personal ratings, and notes. Built with Express.js and TypeScript, this API provides endpoints for retrieving and creating gig entries.

**Status**: MVP complete (November 24, 2025)
- All required endpoints implemented and tested
- Comprehensive input validation with timezone-safe date handling
- Server running on port 5000
- Ready for frontend integration

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Architecture

**Problem**: Need a lightweight, scalable API server to handle gig data operations.

**Solution**: Express.js with TypeScript for type safety and developer experience.

**Rationale**:
- Express provides a minimal, flexible framework ideal for RESTful APIs
- TypeScript adds compile-time type checking, reducing runtime errors
- ts-node-dev enables rapid development with automatic reloading

**Pros**:
- Quick setup and development
- Large ecosystem and community support
- Strong typing improves code maintainability

**Cons**:
- Currently uses in-memory data storage (not persistent)
- No built-in validation framework (manual validation implemented)

### Data Layer

**Problem**: Need to store and retrieve gig records.

**Current Solution**: In-memory array storage with hardcoded sample data.

**Rationale**: Simplifies initial development and testing without database dependencies.

**Pros**:
- Zero configuration required
- Fast read/write operations
- Easy to understand and modify

**Cons**:
- Data is not persistent across server restarts
- Not suitable for production use
- No concurrent access control
- Limited querying capabilities

**Future Consideration**: The architecture is designed to easily migrate to a persistent database solution (SQL or NoSQL) by replacing the data layer while maintaining the same API interface.

### API Design

**Problem**: Need consistent, predictable endpoints for client applications.

**Solution**: RESTful API design with JSON request/response format.

**Endpoints**:
- `GET /health` - Health check for monitoring
- `GET /gigs` - Retrieve all gigs with count metadata
- `POST /gigs` - Create new gig entries with validation

**Design Decisions**:
- Disabled caching headers to ensure fresh data on every request
- Comprehensive input validation with detailed error messages
- Timezone-safe date validation using UTC methods
- Rating validation includes NaN rejection
- All string inputs are trimmed before storage
- Consistent JSON response format across endpoints

### Type System

**Problem**: Ensure data consistency and prevent runtime type errors.

**Solution**: TypeScript interfaces defining clear data contracts.

**Key Types**:
- `Gig` - Complete gig record including ID
- `CreateGigInput` - Input schema for creating gigs (excludes ID)

**Rationale**: Separation of input and entity types prevents ID manipulation and clarifies API expectations.

### CORS Configuration

**Problem**: Enable cross-origin requests from frontend applications.

**Solution**: CORS middleware with permissive settings for development.

**Rationale**: Allows frontend applications hosted on different domains/ports to consume the API during development.

**Note**: Production deployment should implement stricter CORS policies with specific allowed origins.

## External Dependencies

### Runtime Dependencies

- **express** (^4.19.2) - Web framework for building the API server
- **cors** (^2.8.5) - Middleware for enabling Cross-Origin Resource Sharing

### Development Dependencies

- **typescript** (^5.6.0) - TypeScript compiler for type checking and transpilation
- **ts-node-dev** (^2.0.0) - Development server with automatic restart and TypeScript compilation
- **@types/express** (^4.17.21) - Type definitions for Express
- **@types/cors** (^2.8.17) - Type definitions for CORS middleware

### Future Integration Points

The current architecture has no external service dependencies but is structured to easily integrate:
- Database systems (PostgreSQL, MongoDB, etc.) for persistent storage
- Authentication services (JWT, OAuth) for user management
- Logging services (Winston, Pino) for production monitoring
- Validation libraries (Zod, Joi) for robust input validation