import React from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { subscriptionPlanSchema } from "@/schemas/PlanSchema";
import { SubscriptionPlan } from "@prisma/client";

interface Props {
    onNext: (data: SubscriptionPlan[]) => void;
    onBack: () => void;
    initialData: SubscriptionPlan[];
}

const SubscriptionPlanForm: React.FC<Props> = ({
    onNext,
    onBack,
    initialData,
}) => {
    const {
        register,
        control,
        handleSubmit,
        formState: { errors },
    } = useForm<{ plans: SubscriptionPlan[] }>({
        resolver: zodResolver(subscriptionPlanSchema.array()),
        defaultValues: { plans: initialData.length ? initialData : [{ duration: "ONE_MONTH", price: 0, callsPerWeek: 1, videoMeetings: 1, emailSupport: "GENERAL" }] },
    });

    const { fields, append, remove } = useFieldArray({
        control,
        name: "plans",
    });

    const onSubmit = (data: { plans: SubscriptionPlan[] }) => {
        onNext(data.plans);
    };

    return (
        <form
            onSubmit={handleSubmit(onSubmit)}
            className="w-full max-w-md space-y-4"
        >
            <h2 className="text-xl font-bold">Subscription Plans</h2>
            {fields.map((field, index) => (
                <div key={field.id} className="space-y-2 p-4 border rounded">
                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.duration`}>Duration</Label>
                        <Select onValueChange={(value) => register(`plans.${index}.duration`).onChange({ target: { value } })} defaultValue={field.duration}>
                            <SelectTrigger>
                                <SelectValue placeholder="Select duration" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="ONE_MONTH">One Month</SelectItem>
                                <SelectItem value="THREE_MONTHS">Three Months</SelectItem>
                                <SelectItem value="SIX_MONTHS">Six Months</SelectItem>
                                <SelectItem value="TWELVE_MONTHS">Twelve Months</SelectItem>
                            </SelectContent>
                        </Select>
                        {errors.plans?.[index]?.duration && (
                            <p className="text-red-500">{errors.plans?.[index]?.duration?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.price`}>Price (cents)</Label>
                        <Input
                            id={`plans.${index}.price`}
                            type="number"
                            {...register(`plans.${index}.price` as const, { valueAsNumber: true })}
                        />
                        {errors.plans?.[index]?.price && (
                            <p className="text-red-500">{errors.plans?.[index]?.price?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.callsPerWeek`}>Calls Per Week</Label>
                        <Input
                            id={`plans.${index}.callsPerWeek`}
                            type="number"
                            {...register(`plans.${index}.callsPerWeek` as const, { valueAsNumber: true })}
                        />
                        {errors.plans?.[index]?.callsPerWeek && (
                            <p className="text-red-500">{errors.plans?.[index]?.callsPerWeek?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.videoMeetings`}>Video Meetings Per Month</Label>
                        <Input
                            id={`plans.${index}.videoMeetings`}
                            type="number"
                            {...register(`plans.${index}.videoMeetings` as const, { valueAsNumber: true })}
                        />
                        {errors.plans?.[index]?.videoMeetings && (
                            <p className="text-red-500">{errors.plans?.[index]?.videoMeetings?.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor={`plans.${index}.emailSupport`}>Email Support</Label>
                        <Select onValueChange={(value) => register(`plans.${index}.emailSupport`).onChange({ target: { value } })} defaultValue={field.emailSupport}>
                            <SelectTrigger>
                                <SelectValue placeholder="Select email support level" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="GENERAL">General</SelectItem>
                                <SelectItem value="PRIORITY">Priority</SelectItem>
                                <SelectItem value="DEDICATED">Dedicated</SelectItem>
                            </SelectContent>
                        </Select>
                        {errors.plans?.[index]?.emailSupport && (
                            <p className="text-red-500">{errors.plans?.[index]?.emailSupport?.message}</p>
                        )}
                    </div>

                    <Button type="button" onClick={() => remove(index)} variant="outline">
                        Remove Plan
                    </Button>
                </div>
            ))}

            <Button
                type="button"
                onClick={() => append({ id: Date.now().toString(), duration: "ONE_MONTH", price: 0, callsPerWeek: 1, videoMeetings: 1, emailSupport: "GENERAL", consultantProfileId: null, createdAt: new Date(), updatedAt: new Date() })}
                variant="outline"
            >
                Add Plan
            </Button>

            <div className="flex justify-between">
                <Button type="button" onClick={onBack} variant="outline">
                    Back
                </Button>
                <Button type="submit" variant="night">
                    Next
                </Button>
            </div>
        </form>
    );
};

export default SubscriptionPlanForm;