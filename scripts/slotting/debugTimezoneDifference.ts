import { toZonedTime, format, fromZonedTime } from "date-fns-tz";

/**
 * Debug the timezone conversion differences
 */
function debugTimezoneConversion() {
  console.log("🔍 Debugging timezone conversions...");
  
  const timezone = "Africa/Maseru";
  console.log(`🌍 Target timezone: ${timezone}`);
  
  // Raw database slot (Monday 11:00 - 17:00 UTC)
  const dbStartTime = new Date("2025-06-29T11:00:00.000Z");
  const dbEndTime = new Date("2025-06-29T17:00:00.000Z");
  
  console.log(`\n📋 Raw database times (UTC):`);
  console.log(`  Start: ${dbStartTime.toISOString()} (${dbStartTime.getUTCHours()}:${dbStartTime.getUTCMinutes().toString().padStart(2, '0')} UTC)`);
  console.log(`  End: ${dbEndTime.toISOString()} (${dbEndTime.getUTCHours()}:${dbEndTime.getUTCMinutes().toString().padStart(2, '0')} UTC)`);
  
  // Convert to target timezone to see what time they represent locally
  const dbStartLocal = toZonedTime(dbStartTime, timezone);
  const dbEndLocal = toZonedTime(dbEndTime, timezone);
  
  console.log(`\n📍 Raw database times in ${timezone}:`);
  console.log(`  Start: ${format(dbStartLocal, 'yyyy-MM-dd HH:mm:ss zzz', { timeZone: timezone })}`);
  console.log(`  End: ${format(dbEndLocal, 'yyyy-MM-dd HH:mm:ss zzz', { timeZone: timezone })}`);
  
  // How settings page might be interpreting this
  console.log(`\n⚙️  Settings page likely shows:`);
  console.log(`  Start: ${format(dbStartLocal, 'hh:mm a')}`);
  console.log(`  End: ${format(dbEndLocal, 'hh:mm a')}`);
  
  // My current processing logic (WRONG)
  console.log(`\n❌ My current processing (WRONG):`);
  const wrongStartHour = dbStartTime.getUTCHours(); // 11
  const wrongStartMinute = dbStartTime.getUTCMinutes(); // 0
  const wrongEndHour = dbEndTime.getUTCHours(); // 17
  const wrongEndMinute = dbEndTime.getUTCMinutes(); // 0
  
  const currentDate = new Date("2025-06-23T00:00:00.000Z"); // Monday in timezone
  const currentDateTz = toZonedTime(currentDate, timezone);
  
  const wrongStartDateTime = new Date(currentDateTz);
  wrongStartDateTime.setHours(wrongStartHour, wrongStartMinute, 0, 0);
  const wrongEndDateTime = new Date(currentDateTz);
  wrongEndDateTime.setHours(wrongEndHour, wrongEndMinute, 0, 0);
  
  const wrongStartUTC = fromZonedTime(wrongStartDateTime, timezone);
  const wrongEndUTC = fromZonedTime(wrongEndDateTime, timezone);
  
  console.log(`  Extracted hours: ${wrongStartHour}:${wrongStartMinute.toString().padStart(2, '0')} - ${wrongEndHour}:${wrongEndMinute.toString().padStart(2, '0')}`);
  console.log(`  Applied to ${format(currentDateTz, 'yyyy-MM-dd')} in ${timezone}:`);
  console.log(`  Start: ${wrongStartDateTime.toISOString()} → ${wrongStartUTC.toISOString()}`);
  console.log(`  End: ${wrongEndDateTime.toISOString()} → ${wrongEndUTC.toISOString()}`);
  console.log(`  API shows: ${format(wrongStartUTC, 'hh:mm a', { timeZone: timezone })} - ${format(wrongEndUTC, 'hh:mm a', { timeZone: timezone })}`);
  
  // What the CORRECT processing should be
  console.log(`\n✅ CORRECT processing should be:`);
  console.log(`  The database times should be treated as timezone-aware, not UTC patterns`);
  console.log(`  For recurring weekly slots, we should extract the LOCAL time pattern from the stored datetime`);
  
  // Extract the LOCAL time pattern from the original datetime
  const localStartPattern = toZonedTime(dbStartTime, timezone);
  const localEndPattern = toZonedTime(dbEndTime, timezone);
  
  const correctStartHour = localStartPattern.getHours();
  const correctStartMinute = localStartPattern.getMinutes();
  const correctEndHour = localEndPattern.getHours();
  const correctEndMinute = localEndPattern.getMinutes();
  
  console.log(`  Extracted LOCAL pattern: ${correctStartHour}:${correctStartMinute.toString().padStart(2, '0')} - ${correctEndHour}:${correctEndMinute.toString().padStart(2, '0')}`);
  
  // Apply this pattern to a specific day
  const correctStartDateTime = new Date(currentDateTz);
  correctStartDateTime.setHours(correctStartHour, correctStartMinute, 0, 0);
  const correctEndDateTime = new Date(currentDateTz);
  correctEndDateTime.setHours(correctEndHour, correctEndMinute, 0, 0);
  
  const correctStartUTC = fromZonedTime(correctStartDateTime, timezone);
  const correctEndUTC = fromZonedTime(correctEndDateTime, timezone);
  
  console.log(`  Applied to ${format(currentDateTz, 'yyyy-MM-dd')} in ${timezone}:`);
  console.log(`  Start: ${correctStartDateTime.toISOString()} → ${correctStartUTC.toISOString()}`);
  console.log(`  End: ${correctEndDateTime.toISOString()} → ${correctEndUTC.toISOString()}`);
  console.log(`  API should show: ${format(correctStartUTC, 'hh:mm a', { timeZone: timezone })} - ${format(correctEndUTC, 'hh:mm a', { timeZone: timezone })}`);
}

debugTimezoneConversion();