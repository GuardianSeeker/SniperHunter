import fortnitepy
import json
import os
from time import sleep
from webbrowser import open_new

if (os.path.exists("device_auths.json")):
	os.unlink("device_auths.json")
print("YOU MUST USE AN ALT ACCOUNT")
email = input("Epic login email: ")
password = input("Epic login password: ")
os.system("cls")
print("1. The program will now open your browser and you will have to login to Epic Games.\n")
print("2. After you login you will be redirected to a blank page with the following line of text:\n")
print('\t{"redirectUrl":"https://accounts.epicgames.com/fnauth?code=00000000000000000000000000000000","sid":null}\n')
print("3. Please copy the code that appears in place of the 0's and paste it back here.\n")
os.system("pause")
open_new("https://www.epicgames.com/id/logout?redirectUrl=https%3A//www.epicgames.com/id/login%3FredirectUrl%3Dhttps%253A%252F%252Fwww.epicgames.com%252Fid%252Fapi%252Fredirect%253FclientId%253D3446cd72694c4a4485d81b77adbb2141%2526responseType%253Dcode")
filename = 'device_auths.json'

class MyClient(fortnitepy.Client):
	def __init__(self):
		device_auth_details = self.get_device_auth_details().get(email, {})
		super().__init__(
			auth=fortnitepy.AdvancedAuth(
				email=email,
				password=password,
				prompt_authorization_code=True,
				delete_existing_device_auths=True,
				**device_auth_details
			)
		)

	def get_device_auth_details(self):
		if os.path.isfile(filename):
			with open(filename, 'r') as fp:
				return json.load(fp)
		return {}

	def store_device_auth_details(self, email, details):
		existing = self.get_device_auth_details()
		existing[email] = details

		with open(filename, "w") as fp:
			json.dump(existing, fp)

	async def event_device_auth_generate(self, details, email):
		self.store_device_auth_details(email, details)

	async def event_ready(self):
		with open("config.json") as f:
			data = json.load(f)
		f.close()
		data["email"] = email
		with open("config.json", "w") as f:
			json.dump(data, f)
		f.close()
		os.system("cls")
		print("Connected to Epic as {}, you can now use the Sniper Hunter.".format(self.user.display_name))
		print("Exiting in 5 seconds...")
		sleep(5)
		await client.close()

client = MyClient()
client.run()