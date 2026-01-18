import { z } from 'zod';


const CalendarItemSchema = z.object({
    uid: z.string(),
    subject: z.string(),
    startTime: z.number(),
    endTime: z.number(),
    location: z.string().default(''),
    isAllDay: z.boolean().default(false),
    isCancelled: z.boolean().default(false)
});

export { CalendarItemSchema };