function convertUtcToLocalTime(utcDateString: string) {
  // Create a Date object from the UTC time string
  const date = new Date(utcDateString);

  // Get the browser's local time zone dynamically
  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Convert to the user's local time zone
  const options: Intl.DateTimeFormatOptions = {
    timeZone: userTimeZone, // Dynamically set the browser's time zone
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false, // Optional, use 24-hour format
  };

  const formattedDate = new Intl.DateTimeFormat("en-US", options).format(date);

  // Format the output as a string in ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)
  const [month, day, year, hour, minute, second] =
    formattedDate.split(/[\s,\/:]+/);
  const isoFormattedDate = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;

  return isoFormattedDate;
}

function roundToNearest30Minutes(timestamp: string): string {
  // Parse the input timestamp into a Date object
  const date = new Date(timestamp);

  // Get the minutes of the given time
  const minutes = date.getMinutes();
  
  // Calculate the nearest 30-minute interval (either 0 or 30)
  const roundedMinutes = Math.round(minutes / 30) * 30;
  
  // Set the rounded minutes to the date object
  date.setMinutes(roundedMinutes);
  date.setSeconds(0);
  date.setMilliseconds(0);

  // Return the result in ISO 8601 format
  return date.toISOString();
}

export { convertUtcToLocalTime, roundToNearest30Minutes };


