-- Fix subscription plan durations to remove duplicates
-- This script updates the existing subscription plans to have unique durations

-- Update Extended Subscription plans from 6 months to 2 months
UPDATE "SubscriptionPlan" 
SET 
  "durationInMonths" = 2,
  "description" = REPLACE("description", '6 months', '2 months')
WHERE "title" = 'Extended Subscription' AND "durationInMonths" = 6;

-- Update Comprehensive Subscription plans from 6 months to 4 months  
UPDATE "SubscriptionPlan"
SET 
  "durationInMonths" = 4,
  "description" = REPLACE("description", '6 months', '4 months')
WHERE "title" = 'Comprehensive Subscription' AND "durationInMonths" = 6;

-- Verify the changes
SELECT "title", "durationInMonths", COUNT(*) as count
FROM "SubscriptionPlan" 
GROUP BY "title", "durationInMonths"
ORDER BY "durationInMonths", "title";
