import requests
import json

def get_consultees():
    response = requests.get('http://localhost:3000/api/user/consultees')
    return response.json()

def get_webinars(consultee_id):
    response = requests.get(f'http://localhost:3000/api/events/webinars?consulteeProfileId={consultee_id}')
    return response.json()

def main():
    print("Fetching consultees...")
    consultees = get_consultees()
    print(f"Found {len(consultees)} consultees")
    print("\nChecking webinars for each consultee:")
    print("-" * 50)

    for consultee in consultees:
        consultee_id = consultee['id']
        consultee_name = consultee['user']['name']
        
        webinars = get_webinars(consultee_id)
        num_webinars = len(webinars.get('data', []))
        
        if num_webinars > 0:
            print(f"{consultee_name} ({consultee_id}): {num_webinars} webinars")
        else:
            print(f"{consultee_name} ({consultee_id}): No webinars")

if __name__ == "__main__":
    main()
