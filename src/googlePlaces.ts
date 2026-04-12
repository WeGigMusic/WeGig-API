const API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

if (!API_KEY) {
  console.warn('Missing EXPO_PUBLIC_GOOGLE_MAPS_API_KEY');
}

export type PlaceSuggestion = {
  placeId: string;
  title: string;
  subtitle?: string;
};

export type PlaceDetails = {
  placeId: string;
  venueName: string;
  city: string;
  formattedAddress?: string;
  latitude?: number;
  longitude?: number;
};

export const createSessionToken = (): string => {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const searchVenues = async (
  input: string,
  sessionToken: string
): Promise<PlaceSuggestion[]> => {
  if (!input.trim()) return [];

  const response = await fetch(
    'https://places.googleapis.com/v1/places:autocomplete',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY ?? '',
      },
      body: JSON.stringify({
        input,
        sessionToken,
        includedPrimaryTypes: [
          'stadium',
          'concert_hall',
          'performing_arts_theater',
          'event_venue',
        ],
        languageCode: 'en',
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Autocomplete failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  return (data.suggestions ?? [])
    .map((item: any) => item.placePrediction)
    .filter(Boolean)
    .map((place: any) => ({
      placeId: place.placeId,
      title: place.text?.text ?? '',
      subtitle: place.structuredFormat?.secondaryText?.text,
    }));
};

export const getPlaceDetails = async (
  placeId: string,
  sessionToken: string
): Promise<PlaceDetails> => {
  const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': API_KEY ?? '',
      'X-Goog-Session-Token': sessionToken,
      'X-Goog-FieldMask':
        'id,displayName,formattedAddress,addressComponents,location',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Place details failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  return {
    placeId: data.id,
    venueName: data.displayName?.text ?? '',
    city: extractCity(data.addressComponents),
    formattedAddress: data.formattedAddress,
    latitude: data.location?.latitude,
    longitude: data.location?.longitude,
  };
};

const extractCity = (components: any[] = []): string => {
  const preferredTypes = ['locality', 'postal_town', 'administrative_area_level_2'];

  for (const type of preferredTypes) {
    const match = components.find((component) =>
      (component.types ?? []).includes(type)
    );

    if (match?.longText) {
      return match.longText;
    }
  }

  return '';
};