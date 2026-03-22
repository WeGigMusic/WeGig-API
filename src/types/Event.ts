export type EventSource =
  | "ticketmaster"
  | "skiddle"
  | "eventbrite"
  | "setlistfm";

export type NormalizedEvent = {
  source: EventSource;
  sourceEventId: string;

  title: string;

  date?: string;
  time?: string;
  dateTime?: string;

  status?: string;

  ticketUrl?: string;

  venueName?: string;
  city?: string;
  countryCode?: string;

  artists: {
    id?: string;
    name: string;
  }[];
};